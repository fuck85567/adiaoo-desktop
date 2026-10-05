#!/usr/bin/env bash
set -Eeuo pipefail

# Remove the bundled/test content from a deployed ADIAOO instance.
# A timestamped SQLite backup is created before anything is changed.

INSTALL_DIR="${ADIAOO_INSTALL_DIR:-/opt/adiaoo}"
SERVICE_NAME="adiaoo"
DB_FILE="${ADIAOO_DB_PATH:-${INSTALL_DIR}/data/adiaoo.sqlite}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "请使用 root 运行此脚本。" >&2
  exit 1
fi
if [[ ! -f "${DB_FILE}" ]]; then
  echo "找不到数据库：${DB_FILE}" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "找不到 Node.js。" >&2
  exit 1
fi

if systemctl is-active --quiet "${SERVICE_NAME}"; then
  systemctl stop "${SERVICE_NAME}"
fi

node - "${DB_FILE}" <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const dbPath = process.argv[2];
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();
NODE

stamp="$(date +%Y%m%d-%H%M%S)"
backup="${DB_FILE}.before-reset-${stamp}"
cp -a "${DB_FILE}" "${backup}"

node - "${DB_FILE}" <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const dbPath = process.argv[2];
const db = new DatabaseSync(dbPath);
const tables = ['desktop_slots', 'icons', 'trash_items', 'likes', 'favorites', 'ranking_snapshots', 'meta'];
db.exec('BEGIN IMMEDIATE');
try {
  for (const table of tables) db.exec(`DELETE FROM ${table}`);
  const setMeta = db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)');
  setMeta.run('page_count', '1');
  setMeta.run('revision', '0');
  setMeta.run('updated_at', String(Date.now()));
  db.exec('COMMIT');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
} finally {
  db.close();
}
NODE

rm -f "${DB_FILE}-wal" "${DB_FILE}-shm"
chown -R adiaoo:adiaoo "${INSTALL_DIR}/data"
systemctl start "${SERVICE_NAME}"

port="$(awk -F= '$1 == "PORT" { print $2 }' /etc/adiaoo.env 2>/dev/null || true)"
port="${port:-18787}"
if curl -fsS "http://127.0.0.1:${port}/api/desktop" >/dev/null; then
  echo "已清理测试数据，当前桌面为空白。"
  echo "数据库备份：${backup}"
else
  echo "数据已清理，但 ADIAOO 健康检查失败。请运行：systemctl status adiaoo --no-pager" >&2
  exit 1
fi
