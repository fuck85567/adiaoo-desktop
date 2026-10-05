/*
 * ADIAOO shared desktop server.
 * Node 24 provides SQLite through node:sqlite, so no external dependency is needed.
 * The database is the only persistent source of truth for the active desktop,
 * trash, likes and favorites. A legacy JSON file is imported once and retained as a backup.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const configuredRankingThreshold = Number(process.env.RANKING_THRESHOLD || 3);
const RANKING_THRESHOLD = Number.isFinite(configuredRankingThreshold) ? Math.max(1, Math.floor(configuredRankingThreshold)) : 3;
const ROOT = __dirname;
const INDEX_FILE = path.join(ROOT, 'adiaoo-macos-desktop-v4.html');
const LEGACY_DATA_FILE = path.join(ROOT, 'desktop-data.json');
const DB_DIR = path.resolve(process.env.ADIAOO_DATA_DIR || path.join(ROOT, 'data'));
const DB_FILE = path.resolve(process.env.ADIAOO_DB_PATH || path.join(DB_DIR, 'adiaoo.sqlite'));
const SLOT_COUNT = 20;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS icons (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    image TEXT NOT NULL DEFAULT '',
    platform TEXT NOT NULL DEFAULT '',
    auto_logo TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS desktop_slots (
    page_index INTEGER NOT NULL,
    slot_index INTEGER NOT NULL,
    icon_id TEXT,
    PRIMARY KEY (page_index, slot_index),
    FOREIGN KEY (icon_id) REFERENCES icons(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS trash_items (
    trash_id TEXT PRIMARY KEY,
    original_id TEXT NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    image TEXT NOT NULL DEFAULT '',
    platform TEXT NOT NULL DEFAULT '',
    auto_logo TEXT NOT NULL DEFAULT '',
    deleted_at INTEGER NOT NULL,
    deleted_by TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS likes (
    icon_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (icon_id, client_id)
  );
  CREATE TABLE IF NOT EXISTS favorites (
    icon_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (icon_id, client_id)
  );
  CREATE TABLE IF NOT EXISTS ranking_snapshots (
    icon_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    image TEXT NOT NULL DEFAULT '',
    platform TEXT NOT NULL DEFAULT '',
    auto_logo TEXT NOT NULL DEFAULT '',
    ranked_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_likes_icon ON likes(icon_id);
  CREATE INDEX IF NOT EXISTS idx_favorites_icon ON favorites(icon_id);
  CREATE INDEX IF NOT EXISTS idx_trash_deleted_at ON trash_items(deleted_at DESC);
`);

// Add metadata columns to databases created by the previous v4 schema.
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(entry => entry.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn('icons', 'platform', "TEXT NOT NULL DEFAULT ''");
ensureColumn('icons', 'auto_logo', "TEXT NOT NULL DEFAULT ''");
ensureColumn('trash_items', 'platform', "TEXT NOT NULL DEFAULT ''");
ensureColumn('trash_items', 'auto_logo', "TEXT NOT NULL DEFAULT ''");

function detachCounterTable(table) {
  const references = db.prepare(`PRAGMA foreign_key_list(${table})`).all();
  if (references.length) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE ${table}_detached (
        icon_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (icon_id, client_id)
      );
      INSERT OR IGNORE INTO ${table}_detached(icon_id, client_id, created_at)
        SELECT icon_id, client_id, created_at FROM ${table};
      DROP TABLE ${table};
      ALTER TABLE ${table}_detached RENAME TO ${table};
      CREATE INDEX IF NOT EXISTS idx_${table}_icon ON ${table}(icon_id);
      COMMIT;
    `);
  }
}
detachCounterTable('likes');
detachCounterTable('favorites');

function getMeta(key, fallback = '') {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? fallback;
}

function setMeta(key, value) {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

function createId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function emptyPage() {
  return { slots: Array(SLOT_COUNT).fill(null) };
}

function copyIcon(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id: String(raw.id || createId()),
    name: String(raw.name || '未命名'),
    url: String(raw.url || ''),
    image: typeof raw.image === 'string' ? raw.image : '',
    platform: typeof raw.platform === 'string' ? raw.platform : '',
    autoLogo: typeof raw.autoLogo === 'string' ? raw.autoLogo : ''
  };
}

function normalizeSnapshot(raw) {
  const pages = Array.isArray(raw?.pages) ? raw.pages.map(page => {
    const slots = Array(SLOT_COUNT).fill(null);
    const source = Array.isArray(page?.slots) ? page.slots : [];
    source.slice(0, SLOT_COUNT).forEach((item, index) => { slots[index] = copyIcon(item); });
    return { slots };
  }) : [emptyPage()];
  const seen = new Set();
  pages.forEach(page => page.slots.forEach((item, index) => {
    if (!item || !item.id || seen.has(item.id)) page.slots[index] = null;
    else seen.add(item.id);
  }));
  return {
    version: 5,
    revision: Number(raw?.revision) || 0,
    updatedAt: Number(raw?.updatedAt) || Date.now(),
    pages: pages.length ? pages : [emptyPage()],
    trash: Array.isArray(raw?.trash) ? raw.trash.map(item => ({
      ...copyIcon(item),
      deletedAt: Number(item.deletedAt) || Date.now(),
      deletedBy: String(item.deletedBy || 'anonymous')
    })) : []
  };
}

function migrateLegacyJson() {
  if (getMeta('schema_version')) return;
  let raw = { version: 5, revision: 0, updatedAt: Date.now(), pages: [emptyPage()], trash: [] };
  if (fs.existsSync(LEGACY_DATA_FILE)) raw = JSON.parse(fs.readFileSync(LEGACY_DATA_FILE, 'utf8'));
  const snapshot = normalizeSnapshot(raw);
  applySnapshot(snapshot, { incrementRevision: false });
  setMeta('schema_version', 1);
  setMeta('revision', snapshot.revision);
  setMeta('updated_at', snapshot.updatedAt);
  // Keep the source JSON as a backup after the one-time SQLite import.
}

function readIcons(clientId = '') {
  const rows = db.prepare(`
    SELECT i.id, i.name, i.url, i.image, i.platform, i.auto_logo,
           COUNT(DISTINCT l.client_id) AS likeCount,
           (SELECT COUNT(*) FROM favorites f WHERE f.icon_id = i.id) AS favoriteCount
    FROM icons i
    LEFT JOIN likes l ON l.icon_id = i.id
    GROUP BY i.id
  `).all();
  const liked = clientId ? new Set(db.prepare('SELECT icon_id FROM likes WHERE client_id = ?').all(String(clientId)).map(row => row.icon_id)) : new Set();
  return new Map(rows.map(row => [row.id, {
    id: row.id,
    name: row.name,
    url: row.url,
    image: row.image,
    platform: row.platform || '',
    autoLogo: row.auto_logo || '',
    likeCount: Number(row.likeCount) || 0,
    favoriteCount: Number(row.favoriteCount) || 0,
    likedByCurrentClient: liked.has(row.id)
  }]));
}

function readCounts(ids, clientId = '') {
  const uniqueIds = [...new Set(ids.map(String).filter(Boolean))].slice(0, 200);
  const counts = Object.fromEntries(uniqueIds.map(id => [id, { likeCount: 0, favoriteCount: 0, likedByCurrentClient: false }]));
  if (!uniqueIds.length) return counts;
  const placeholders = uniqueIds.map(() => '?').join(', ');
  for (const row of db.prepare(`SELECT icon_id, COUNT(*) AS count, MAX(CASE WHEN client_id = ? THEN 1 ELSE 0 END) AS liked_by_client FROM likes WHERE icon_id IN (${placeholders}) GROUP BY icon_id`).all(String(clientId), ...uniqueIds)) {
    counts[row.icon_id].likeCount = Number(row.count) || 0;
    counts[row.icon_id].likedByCurrentClient = Boolean(row.liked_by_client);
  }
  for (const row of db.prepare(`SELECT icon_id, COUNT(*) AS count FROM favorites WHERE icon_id IN (${placeholders}) GROUP BY icon_id`).all(...uniqueIds)) {
    counts[row.icon_id].favoriteCount = Number(row.count) || 0;
  }
  return counts;
}

function snapshotRankedIcon(iconId) {
  const icon = db.prepare('SELECT id, name, url, image, platform, auto_logo FROM icons WHERE id = ?').get(String(iconId));
  if (!icon) return false;
  db.prepare(`
    INSERT OR IGNORE INTO ranking_snapshots(icon_id, name, url, image, platform, auto_logo, ranked_at)
    VALUES(?, ?, ?, ?, ?, ?, ?)
  `).run(icon.id, icon.name, icon.url, icon.image, icon.platform || '', icon.auto_logo || '', Date.now());
  return true;
}

function readRanking(sortBy = 'likes', clientId = '') {
  const rows = db.prepare('SELECT icon_id, name, url, image, platform, auto_logo, ranked_at FROM ranking_snapshots').all();
  const counts = readCounts(rows.map(row => row.icon_id), clientId);
  const items = rows.map(row => ({
    id: row.icon_id,
    name: row.name,
    url: row.url,
    image: row.image || '',
    platform: row.platform || '',
    autoLogo: row.auto_logo || '',
    rankedAt: Number(row.ranked_at) || 0,
    ...(counts[row.icon_id] || { likeCount: 0, favoriteCount: 0, likedByCurrentClient: false })
  }));
  const score = sortBy === 'favorites' ? 'favoriteCount' : 'likeCount';
  const other = sortBy === 'favorites' ? 'likeCount' : 'favoriteCount';
  const eligible = sortBy === 'favorites'
    ? items.filter(item => item.favoriteCount > 0)
    : items.filter(item => item.likeCount >= RANKING_THRESHOLD);
  eligible.sort((a, b) => b[score] - a[score] || b[other] - a[other] || a.rankedAt - b.rankedAt);
  return eligible;
}

function backfillRankingSnapshots() {
  const rows = db.prepare(`
    SELECT i.id
    FROM icons i JOIN likes l ON l.icon_id = i.id
    GROUP BY i.id HAVING COUNT(DISTINCT l.client_id) >= ?
    UNION
    SELECT i.id
    FROM icons i JOIN favorites f ON f.icon_id = i.id
    GROUP BY i.id
  `).all(RANKING_THRESHOLD);
  rows.forEach(row => snapshotRankedIcon(row.id));
}

function readState(clientId = '') {
  const iconMap = readIcons(clientId);
  const pageCount = Math.max(1, Number(getMeta('page_count', 1)) || 1);
  const pages = Array.from({ length: pageCount }, () => emptyPage());
  const slots = db.prepare('SELECT page_index, slot_index, icon_id FROM desktop_slots ORDER BY page_index, slot_index').all();
  slots.forEach(row => {
    if (!pages[row.page_index]) pages[row.page_index] = emptyPage();
    pages[row.page_index].slots[row.slot_index] = row.icon_id ? (iconMap.get(row.icon_id) || null) : null;
  });
  const trash = db.prepare(`
    SELECT trash_id, original_id, name, url, image, platform, auto_logo, deleted_at, deleted_by
    FROM trash_items ORDER BY deleted_at DESC
  `).all().map(row => ({
    id: row.original_id,
    name: row.name,
    url: row.url,
    image: row.image,
    platform: row.platform || '',
    autoLogo: row.auto_logo || '',
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by
  }));
  return {
    version: 5,
    revision: Number(getMeta('revision', 0)) || 0,
    updatedAt: Number(getMeta('updated_at', Date.now())) || Date.now(),
    pages,
    trash
  };
}

function applySnapshot(raw, { incrementRevision = true, clientId = '' } = {}) {
  const snapshot = normalizeSnapshot(raw);
  const now = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    const upsertIcon = db.prepare(`
      INSERT INTO icons(id, name, url, image, platform, auto_logo, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        url = excluded.url,
        image = excluded.image,
        platform = excluded.platform,
        auto_logo = excluded.auto_logo,
        updated_at = excluded.updated_at
    `);
    snapshot.pages.forEach(page => page.slots.forEach(item => {
      if (item) upsertIcon.run(item.id, item.name, item.url, item.image, item.platform, item.autoLogo, now, now);
    }));

    db.prepare('DELETE FROM desktop_slots').run();
    const saveSlot = db.prepare('INSERT INTO desktop_slots(page_index, slot_index, icon_id) VALUES(?, ?, ?)');
    snapshot.pages.forEach((page, pageIndex) => page.slots.forEach((item, slotIndex) => {
      saveSlot.run(pageIndex, slotIndex, item?.id || null);
    }));

    // Icons no longer on the desktop are removed from the active table; their trash snapshot remains.
    db.prepare('DELETE FROM icons WHERE id NOT IN (SELECT icon_id FROM desktop_slots WHERE icon_id IS NOT NULL)').run();
    db.prepare('DELETE FROM trash_items').run();
    const saveTrash = db.prepare(`
      INSERT INTO trash_items(trash_id, original_id, name, url, image, platform, auto_logo, deleted_at, deleted_by)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    snapshot.trash.forEach(item => saveTrash.run(`${item.id}-${item.deletedAt}-${Math.random().toString(16).slice(2)}`, item.id, item.name, item.url, item.image, item.platform, item.autoLogo, item.deletedAt, item.deletedBy));

    const currentRevision = Number(getMeta('revision', 0)) || 0;
    setMeta('page_count', snapshot.pages.length);
    setMeta('revision', incrementRevision ? currentRevision + 1 : snapshot.revision);
    setMeta('updated_at', now);
    db.exec('COMMIT');
    return readState(clientId);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function likeIcon(iconId, clientId) {
  if (!iconId || !clientId) throw new Error('iconId and clientId are required');
  db.exec('BEGIN IMMEDIATE');
  try {
    const exists = db.prepare('SELECT id FROM icons WHERE id = ?').get(String(iconId));
    if (!exists) {
      db.exec('ROLLBACK');
      return { found: false };
    }
    const result = db.prepare('INSERT OR IGNORE INTO likes(icon_id, client_id, created_at) VALUES(?, ?, ?)').run(String(iconId), String(clientId), Date.now());
    const count = db.prepare('SELECT COUNT(*) AS count FROM likes WHERE icon_id = ?').get(String(iconId)).count;
    if (Number(count) >= RANKING_THRESHOLD) snapshotRankedIcon(iconId);
    if (Number(result.changes) > 0) {
      setMeta('revision', (Number(getMeta('revision', 0)) || 0) + 1);
      setMeta('updated_at', Date.now());
    }
    db.exec('COMMIT');
    return { found: true, added: Number(result.changes) > 0, likeCount: Number(count), revision: Number(getMeta('revision', 0)) || 0 };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function favoriteIcon(iconId, clientId) {
  if (!iconId || !clientId) throw new Error('iconId and clientId are required');
  const exists = db.prepare('SELECT id FROM icons WHERE id = ? UNION SELECT icon_id AS id FROM ranking_snapshots WHERE icon_id = ?').get(String(iconId), String(iconId));
  if (!exists) return { found: false };
  const result = db.prepare('INSERT OR IGNORE INTO favorites(icon_id, client_id, created_at) VALUES(?, ?, ?)').run(String(iconId), String(clientId), Date.now());
  const count = db.prepare('SELECT COUNT(*) AS count FROM favorites WHERE icon_id = ?').get(String(iconId)).count;
  if (Number(count) > 0) snapshotRankedIcon(iconId);
  return { found: true, added: Number(result.changes) > 0, favoriteCount: Number(count) };
}

migrateLegacyJson();
backfillRankingSnapshots();

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let received = 0;
    let failed = false;
    req.on('data', chunk => {
      if (failed) return;
      received += chunk.length;
      if (received > 12 * 1024 * 1024) {
        failed = true;
        const error = new Error('payload too large');
        error.status = 413;
        reject(error);
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (failed) return;
      try { resolve(JSON.parse(body || '{}')); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function serveFile(req, res) {
  let requestPath;
  try {
    requestPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  } catch (error) {
    res.writeHead(400);
    return res.end('Bad request');
  }
  const relative = requestPath === '/' ? path.basename(INDEX_FILE) : requestPath.replace(/^\/+/, '');
  const publicFiles = new Set([path.basename(INDEX_FILE), 'adiaoo-macos-desktop-v4.css', 'adiaoo-macos-desktop-v4.js']);
  if (!publicFiles.has(relative) || relative.includes('/') || relative.includes('\\')) {
    res.writeHead(404);
    return res.end('Not found');
  }
  const file = path.join(ROOT, relative);
  fs.readFile(file, (error, content) => {
    if (error) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(content);
  });
}

let writeQueue = Promise.resolve();
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS' });
    return res.end();
  }
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  if (pathname === '/api/desktop' && req.method === 'GET') {
    const clientId = new URL(req.url, `http://${req.headers.host}`).searchParams.get('clientId') || '';
    return sendJson(res, 200, readState(clientId));
  }
  if (pathname === '/api/desktop/counts' && req.method === 'GET') {
    const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
    const ids = params.get('ids') || '';
    return sendJson(res, 200, { counts: readCounts(ids.split(','), params.get('clientId') || '') });
  }
  if (pathname === '/api/desktop/ranking' && req.method === 'GET') {
    const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
    const sortBy = params.get('sort') === 'favorites' ? 'favorites' : 'likes';
    return sendJson(res, 200, { items: readRanking(sortBy, params.get('clientId') || ''), threshold: RANKING_THRESHOLD });
  }
  if (pathname === '/api/desktop/like' && req.method === 'POST') {
    return readBody(req).then(body => {
      writeQueue = writeQueue.catch(() => {}).then(() => {
        const result = likeIcon(body.iconId, body.clientId);
        if (!result.found) return sendJson(res, 404, { error: 'icon_not_found' });
        return sendJson(res, 200, result);
      });
      return writeQueue;
    }).catch(error => sendJson(res, error.status || 400, { error: error.message }));
  }
  if (pathname === '/api/desktop/favorite' && req.method === 'POST') {
    return readBody(req).then(body => {
      writeQueue = writeQueue.catch(() => {}).then(() => {
        const result = favoriteIcon(body.iconId, body.clientId);
        if (!result.found) return sendJson(res, 404, { error: 'icon_not_found' });
        return sendJson(res, 200, result);
      });
      return writeQueue;
    }).catch(error => sendJson(res, error.status || 400, { error: error.message }));
  }
  if (pathname === '/api/desktop' && req.method === 'PUT') {
    return readBody(req).then(body => {
      writeQueue = writeQueue.catch(() => {}).then(() => {
        const currentRevision = Number(getMeta('revision', 0)) || 0;
        if (Number(body.baseRevision) !== currentRevision) return sendJson(res, 409, { error: 'revision_conflict', state: readState(body.clientId || '') });
        return sendJson(res, 200, applySnapshot(body, { clientId: body.clientId || '' }));
      });
      return writeQueue;
    }).catch(error => sendJson(res, error.status || 400, { error: error.message }));
  }
  if (req.method === 'GET') return serveFile(req, res);
  res.writeHead(405, { 'Allow': 'GET,PUT,POST,OPTIONS' });
  res.end('Method not allowed');
});

server.listen(PORT, HOST, () => console.log(`ADIAOO SQLite desktop: http://localhost:${PORT}/adiaoo-macos-desktop-v4.html`));
