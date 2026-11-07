# Nginx 分离部署

Nginx 负责托管两个前端，并把 API 和 WebSocket 代理到同一个后端。生产不要让后端直接托管前端静态文件。

模板文件：

```text
deploy/nginx-split-intranet.conf.example
```

## 統一倉與 Compose

上方模板相對於 `XPayincus/`，適用宿主靜態目錄部署。Compose 改用 `XPayincus/deploy/compose/https-proxy.conf.example`：宿主 HTTPS 代理分別轉送到 `127.0.0.1:8080`、`127.0.0.1:8081`，不直接讀取宿主 `client/dist`。API 與 DB 不發布宿主埠，兩前端轉送至同一個 API；禁止多 Node 程序、多 worker 或多副本。

外層可信代理必須覆寫 `X-Real-IP`；若前方有 CDN，先限制可信來源網段。兩端使用不同 HTTPS origin，`COOKIE_DOMAIN` 保持空值。Agent、Incus、RFW、ZFS 保留宿主部署。

以下驗證命令為宿主部署參考；`pnpm` 指令從 `XPayincus/` 或已部署的面板 release 執行。本次未執行 Nginx 檢查、reload、測試或部署。

## 替换项

| 模板值 | 替换为 |
| --- | --- |
| `pay.xpayincus.com` | 用户端域名，例如 `panel.example.com` |
| `admin.xpayincus.com` | 后台域名，例如 `admin.example.com` |
| `/opt/incudal/current/client/dist/user` | 用户端当前 release 静态目录 |
| `/opt/incudal/current/client/dist/admin` | 后台当前 release 静态目录 |
| `10.0.0.12:3001` | 后端内网 IP 和端口，单机部署可用 `127.0.0.1:3001` |

## 必须保持的边界

```text
用户端域名 -> /opt/incudal/current/client/dist/user
后台域名 -> /opt/incudal/current/client/dist/admin
/api/ -> 后端 /api/
/api/ws/ -> 后端 /api/ws/
```

不要把后台静态目录挂到用户端域名，也不要把用户端静态目录挂到后台域名。两个域名都通过同源 `/api` 访问同一个后端。

## WebSocket

终端和实时任务依赖 `/api/ws/`，必须设置升级头：

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
proxy_buffering off;
```

## OTA 缓存规则

- `index.html` 使用 `expires epoch`，确保 OTA 切换 release 后浏览器重新读取新的 SPA 入口。
- `/assets/` 使用独立 `location` 和长期缓存，因为 Vite 资产文件名带 hash，内容变化会生成新路径。
- 如果前面有 Cloudflare/CDN，不要给 `index.html` 设置长期缓存。

## 安全响应头

模板默认设置：

```text
Content-Security-Policy
X-Frame-Options
X-Content-Type-Options
Referrer-Policy
Strict-Transport-Security
```

如果前面还有反代、WAF 或 CDN，验收时要检查公网最终响应仍保留这些响应头。

## 验证

```bash
nginx -t
systemctl reload nginx
```

```bash
FRONTEND_URL=https://panel.example.com \
ADMIN_FRONTEND_URL=https://admin.example.com \
BACKEND_URL=http://127.0.0.1:3001 \
pnpm verify:split:host
```

`verify:split:host` 会检查用户端和后台域名是否指向正确构建产物、`/api/health` 是否可用，以及 WebSocket 路径是否满足基础要求。
