#!/usr/bin/env bash
set -Eeuo pipefail

# ADIAOO one-click deployment script.
# It installs the runtime, keeps the existing SQLite database, chooses a free
# private port, and creates an isolated systemd service.

REPO_URL="${ADIAOO_REPO_URL:-https://github.com/fuck85567/adiaoo-desktop.git}"
BRANCH="${ADIAOO_BRANCH:-master}"
INSTALL_DIR="${ADIAOO_INSTALL_DIR:-/opt/adiaoo}"
SERVICE_NAME="adiaoo"
BASE_PORT="${ADIAOO_PORT:-18787}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "请使用 root 运行：sudo bash install.sh" >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "此一键脚本目前支持 Debian/Ubuntu。" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git iproute2

node_is_supported=0
if command -v node >/dev/null 2>&1; then
  node_is_supported="$(node -p "const [major,minor]=process.versions.node.split('.').map(Number); Number(major > 22 || (major === 22 && minor >= 13))")"
fi

if [[ "${node_is_supported}" != "1" ]]; then
  echo "正在安装 Node.js 24..."
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi

if ! id -u adiaoo >/dev/null 2>&1; then
  useradd --system --home-dir "${INSTALL_DIR}" --shell /usr/sbin/nologin adiaoo
fi

tmp_dir="$(mktemp -d)"
cleanup() { rm -rf "${tmp_dir}"; }
trap cleanup EXIT

echo "正在下载 GitHub 版本..."
git clone --depth 1 --branch "${BRANCH}" "${REPO_URL}" "${tmp_dir}/repo"

for required_file in server.js adiaoo-macos-desktop-v4.html adiaoo-macos-desktop-v4.css adiaoo-macos-desktop-v4.js; do
  if [[ ! -f "${tmp_dir}/repo/${required_file}" ]]; then
    echo "仓库缺少文件：${required_file}" >&2
    exit 1
  fi
done

# Stop only ADIAOO while replacing its files. Existing applications are not touched.
if systemctl is-active --quiet "${SERVICE_NAME}"; then
  systemctl stop "${SERVICE_NAME}"
fi

# Keep live server data when this script is run again for an update.
if [[ -f "${INSTALL_DIR}/data/adiaoo.sqlite" ]]; then
  install -d "${tmp_dir}/repo/data"
  cp -f "${INSTALL_DIR}/data/adiaoo.sqlite" "${tmp_dir}/repo/data/adiaoo.sqlite"
fi

install -d "${INSTALL_DIR}" "${INSTALL_DIR}/data"
install -m 0644 "${tmp_dir}/repo/server.js" "${INSTALL_DIR}/server.js"
install -m 0644 "${tmp_dir}/repo/adiaoo-macos-desktop-v4.html" "${INSTALL_DIR}/adiaoo-macos-desktop-v4.html"
install -m 0644 "${tmp_dir}/repo/adiaoo-macos-desktop-v4.css" "${INSTALL_DIR}/adiaoo-macos-desktop-v4.css"
install -m 0644 "${tmp_dir}/repo/adiaoo-macos-desktop-v4.js" "${INSTALL_DIR}/adiaoo-macos-desktop-v4.js"
install -m 0644 "${tmp_dir}/repo/data/adiaoo.sqlite" "${INSTALL_DIR}/data/adiaoo.sqlite"
if [[ -f "${tmp_dir}/repo/README.md" ]]; then
  install -m 0644 "${tmp_dir}/repo/README.md" "${INSTALL_DIR}/README.md"
fi

port_is_busy() {
  local port="$1"
  ss -Hln 2>/dev/null | awk -v p=":${port}" '$4 ~ (p "$" ) { found=1 } END { exit found ? 0 : 1 }'
}

if ! [[ "${BASE_PORT}" =~ ^[0-9]+$ ]] || (( BASE_PORT < 1024 || BASE_PORT > 65535 )); then
  echo "ADIAOO_PORT 必须是 1024 到 65535 之间的端口。" >&2
  exit 1
fi

PORT="${BASE_PORT}"
while port_is_busy "${PORT}"; do
  ((PORT++))
  if (( PORT > 65535 )); then
    echo "没有找到可用端口。" >&2
    exit 1
  fi
done

cat >/etc/adiaoo.env <<EOF
HOST=127.0.0.1
PORT=${PORT}
ADIAOO_DATA_DIR=${INSTALL_DIR}/data
EOF
chmod 0640 /etc/adiaoo.env
chown root:adiaoo /etc/adiaoo.env

cat >/etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=ADIAOO Desktop
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=adiaoo
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=/etc/adiaoo.env
ExecStart=/usr/bin/node ${INSTALL_DIR}/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

chown -R adiaoo:adiaoo "${INSTALL_DIR}"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}" >/dev/null
systemctl restart "${SERVICE_NAME}"

for attempt in {1..20}; do
  if curl -fsS "http://127.0.0.1:${PORT}/api/desktop" >/dev/null 2>&1; then
    echo
    echo "ADIAOO 已启动。"
    echo "本机服务地址：http://127.0.0.1:${PORT}"
    echo "Cloudflare Tunnel Service URL：http://127.0.0.1:${PORT}"
    echo
    echo "在 Cloudflare 中把 adiaoo.top 的 Published application 指向上面的 Service URL。"
    echo "不要开放 ${PORT} 端口；它只监听 127.0.0.1。"
    exit 0
  fi
  sleep 1
done

echo "ADIAOO 启动失败，请查看：systemctl status ${SERVICE_NAME} --no-pager" >&2
journalctl -u "${SERVICE_NAME}" -n 80 --no-pager >&2 || true
exit 1
