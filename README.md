# ADIAOO Desktop

ADIAOO 是一个由 Node.js 提供静态桌面页面和 SQLite 数据服务的项目。

## 运行环境

- Debian/Ubuntu Linux
- Node.js 24（最低 Node.js 22.13）
- Cloudflare Tunnel

## 本地启动

```bash
HOST=127.0.0.1 PORT=18787 node server.js
```

访问 `http://127.0.0.1:18787/`。

## 服务器部署要点

建议将项目放到 `/opt/adiaoo`，使用独立用户和 systemd 运行，并让服务只监听 `127.0.0.1:18787`。然后在 Cloudflare Tunnel 中创建 Published application route：

```text
Hostname: adiaoo.top
Service:  http://127.0.0.1:18787
```

如果 `adiaoo.top` 已经绑定其他应用，请使用单独的子域名，例如 `desktop.adiaoo.top`。

## 数据

`data/adiaoo.sqlite` 保存当前桌面、回收站、点赞、收藏和排行榜数据。SQLite 的 `-wal`、`-shm` 临时文件不会提交到仓库。

不要把此私有仓库改为公开仓库，因为数据库可能包含站点图标和统计数据。
