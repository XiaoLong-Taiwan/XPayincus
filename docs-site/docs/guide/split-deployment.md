# 前后台分离

XPayincus 的生产标准是两个公网前端域名、两个 Vite 构建产物、一个共享后端 API。用户端和后台不是同一个 SPA 里用路由隐藏页面，而是从入口、路由、API client、导航和部署目录上分开。

## 代码边界

| 范围 | 用户端 | 管理端 |
| --- | --- | --- |
| Vite 入口 | `VITE_APP_ENTRY=user` | `VITE_APP_ENTRY=admin` |
| 路由 | `client/src/router/user.ts` | `client/src/router/admin.ts` |
| 入口文件 | `client/src/main.ts` | `client/src/admin/main.ts` |
| API client | `client/src/api/index.ts` | `client/src/api/admin.ts` |
| URL helper | `app-paths-user` | `app-paths-admin` |
| 构建目录 | `client/dist/user` | `client/dist/admin` |

## 部署边界

```text
https://panel.example.com
  -> /opt/xpayincus/current/client/dist/user
  -> /api, /api/ws -> backend

https://admin.example.com
  -> /opt/xpayincus/current/client/dist/admin
  -> /api, /api/ws -> backend
```

后端生产设置 `SERVE_STATIC_CLIENT=false`，静态文件只由 Nginx 服务。

## 行为边界

- 普通用户不能进入 `/admin` 路由或后台 API。
- 管理员账号不能进入用户端业务页面，避免后台账号误用客户侧自助流程。
- 用户端构建产物不能包含后台入口、后台 API client、后台导航或后台文案。
- 后台构建产物不能包含用户端充值、签到、好友、转移、套餐分享等客户自助入口。
- 后台生成客户链接时必须使用 `FRONTEND_URL`，不能使用后台域名。

## 验证命令

```bash
pnpm --filter server test:frontend-route-guards
pnpm --filter server test:frontend-dist-boundary-guards
```

生产域名验证：

```bash
FRONTEND_URL=https://panel.example.com \
ADMIN_FRONTEND_URL=https://admin.example.com \
BACKEND_URL=http://127.0.0.1:3001 \
pnpm verify:split:host
```

这些检查只能证明构建和域名边界。真实登录、支付回调、WebSocket 终端和管理员权限仍需要线上 proof。
