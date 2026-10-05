# ADIAOO Desktop

ADIAOO 是一个由 Node.js 提供静态桌面页面和 SQLite 数据服务的项目。

## 一键部署

服务器是 Debian/Ubuntu 时，使用 root 执行：

```bash
curl -fsSL https://raw.githubusercontent.com/fuck85567/adiaoo-desktop/master/install.sh | bash
```

脚本会自动安装 Node.js 24、下载项目、保留已有 SQLite 数据、检测可用端口、创建独立的 `adiaoo` systemd 服务，并让服务只监听 `127.0.0.1`。如果默认端口 `18787` 已被占用，脚本会自动选择下一个空闲端口并显示给你。

重复执行同一条命令可以更新代码；服务器上的 `data/adiaoo.sqlite` 会保留，不会被 GitHub 仓库里的初始数据覆盖。

## Cloudflare Tunnel

一键脚本完成后，在 Cloudflare Zero Trust 的 Tunnel 中创建 Published application：

```text
Hostname: adiaoo.top
Service URL: http://127.0.0.1:18787
```

以脚本最后显示的端口为准。如果 `adiaoo.top` 已经绑定其他应用，请改用单独的子域名，例如 `desktop.adiaoo.top`。不要开放 ADIAOO 的本地端口到公网。

## 手动启动

```bash
HOST=127.0.0.1 PORT=18787 node server.js
```

项目使用 Node.js `node:sqlite`，需要 Node.js 22.13 以上，建议使用 Node.js 24。
