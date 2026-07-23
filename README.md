<h1 align="center"><img src="./client/public/xpayincus_logo.webp" width="96" align="absmiddle" alt="XPayincus logo"> XPayincus</h1>

<p align="center">面向 Incus 的 NAT VPS 销售、资源交付、支付账务、Public API 和后台 OTA 平台。</p>

<p align="center">
  <a href="https://xiaolong-taiwan.github.io/XPayincus/">文档站</a>
  ·
  <a href="https://xiaolong-taiwan.github.io/XPayincus/api/overview">API 文档</a>
  ·
  <a href="https://github.com/XiaoLong-Taiwan/XPayincus/releases">Releases</a>
</p>

## 项目定位

XPayincus 是一套面向 hosting 业务的 Incus 商业化交付平台。它把套餐销售、余额扣费、实例创建、NAT 网络、带宽和流量、用户自助后台、管理后台、支付回调、工单通知、宿主机 Agent、Public API 和后台在线升级放到同一套可审计流程里。

XPayincus 面板的公开文档、源码和 Release 以当前仓库为准，宿主机 Agent 由独立仓库维护：

- 项目仓库：<https://github.com/XiaoLong-Taiwan/XPayincus>
- Agent 仓库：<https://github.com/XiaoLong-Taiwan/XPayincus-Agent>
- 文档站：<https://xiaolong-taiwan.github.io/XPayincus/>
- API 参考：<https://xiaolong-taiwan.github.io/XPayincus/api/overview>

## 核心能力

- 实例交付：基于 Incus 创建和管理 LXC / KVM 实例，支持 NAT、IPv6、镜像、套餐、方案、存储池、带宽和月流量。
- 用户后台：注册登录、套餐购买、实例列表、实例详情、Web 终端、续费、升级、钱包、订单、工单、通知、礼品卡、邮箱和托管节点。
- 管理后台：用户、套餐、方案、节点、镜像、订单、支付渠道、财务对账、系统配置、日志、通知、资源池和 OTA。
- 计费账务：余额、在线充值、人工充值、支付回调、消费记录、余额调整、订单退款审批、对账、返利、积分、VIP 福利和礼品卡兑换。
- 开放接口：OAuth Provider、`pat_` API Token、`poa_` OAuth Access Token、OpenAPI 3.1、Public API SDK、scope、分页、排序和统一错误模型。
- 宿主机 Agent：节点安装脚本、心跳、资源上报、实例状态、流量采集、Agent manifest 和二进制下载代理。
- 后台 OTA：管理后台查看版本、检查 Release、下载 OTA artifact、校验 SHA256、运行更新任务、查看日志和回滚。

## 技术栈

```text
client/                 Vue 3 + Vite，用户端和管理端双入口
server/                 Fastify + Prisma + PostgreSQL 后端
外部 Agent 仓库         https://github.com/XiaoLong-Taiwan/XPayincus-Agent
server/prisma/          Prisma schema 和 migrations
server/templates/       节点安装、Agent 和证书模板
deploy/                 systemd 和 Nginx 生产模板
scripts/                安装、构建、验证、OTA 和 smoke 脚本
docs-site/              VitePress 文档站
```

运行依赖：

- Linux 生产环境，推荐 Debian / Ubuntu
- Node.js 20+，生产推荐 Node.js 22
- pnpm 9.14.2
- PostgreSQL，生产推荐 PostgreSQL 16
- Redis（建议 7；一键安装使用系统仓库版本），安装脚本会保留 `REDIS_URL` 兼容后续分布式状态扩展
- Nginx + systemd

## 推荐生产架构

XPayincus 生产环境推荐非 Docker split 部署：用户端、管理端和后端 API 分离，但两个前端都通过同源 `/api` 与 `/api/ws` 访问同一个后端。

```text
用户浏览器
  -> https://panel.example.com
  -> Nginx: /opt/xpayincus/current/client/dist/user
  -> /api, /api/ws -> http://10.0.0.12:3001

管理员浏览器
  -> https://admin.example.com
  -> Nginx: /opt/xpayincus/current/client/dist/admin
  -> /api, /api/ws -> http://10.0.0.12:3001

后端服务
  -> /opt/xpayincus/current/server/dist/app.js
  -> PostgreSQL / Incus / Agent / Mail / Payment Provider
```

关键约束：

- 用户端域名和管理端域名必须分离。
- `FRONTEND_URL` 指向用户端，`ADMIN_FRONTEND_URL` 指向管理端。
- `PAYMENT_CALLBACK_BASE_URL` 通常等于用户端公网域名。
- 生产必须设置 `SERVE_STATIC_CLIENT=false`，前端静态文件由 Nginx 托管。
- 用户端构建目录是 `client/dist/user`，管理端构建目录是 `client/dist/admin`。
- 后端默认监听 `HOST=127.0.0.1`、`PORT=3001`。
- 默认安装目录仍是 `/opt/xpayincus`，这是当前脚本、systemd、OTA 和线上 release 布局使用的真实路径。

## 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/XiaoLong-Taiwan/XPayincus/main/scripts/install-panel.sh -o install-panel.sh
sudo bash install-panel.sh
```

安装脚本会完成：

- 安装 Node.js、pnpm、PostgreSQL、Redis、Nginx 和 systemd 服务。
- 下载 GitHub Release 预构建包。
- 创建 `/opt/xpayincus/.env`。
- 执行 Prisma migration 和 Prisma Client 生成。
- 创建 `xpayincus-backend` 服务。
- 配置用户端和管理端 Nginx 站点。
- 初始化 OTA、证书和运行缓存目录。

升级和卸载：

```bash
sudo bash install-panel.sh --upgrade
sudo bash install-panel.sh --uninstall
```

完整安装说明见：<https://xiaolong-taiwan.github.io/XPayincus/deployment/one-click-install>

## 手动部署

安装依赖并构建：

```bash
corepack enable
corepack prepare pnpm@9.14.2 --activate
pnpm install --frozen-lockfile

pnpm --filter server exec prisma generate
pnpm --filter server exec prisma migrate deploy
VITE_API_BASE_URL=/api \
VITE_CUSTOMER_BASE_URL=https://panel.example.com \
VITE_ADMIN_BASE_URL=https://admin.example.com \
pnpm build
```

确认产物：

```text
client/dist/user/index.html
client/dist/admin/index.html
server/dist/app.js
```

生产启动示例：

```bash
NODE_ENV=production \
HOST=127.0.0.1 \
PORT=3001 \
SERVE_STATIC_CLIENT=false \
FRONTEND_URL=https://panel.example.com \
ADMIN_FRONTEND_URL=https://admin.example.com \
SITE_URL=https://panel.example.com \
PAYMENT_CALLBACK_BASE_URL=https://panel.example.com \
node server/dist/app.js
```

Cookie 隔离要求：`COOKIE_DOMAIN` 必须保持空值，用户端和管理后台子域不能共享 refresh cookie。

systemd 和 Nginx 模板：

```bash
sudo cp deploy/xpayincus-backend.service.example /etc/systemd/system/xpayincus-backend.service
sudo systemctl daemon-reload
sudo systemctl enable --now xpayincus-backend

# Nginx split template
deploy/nginx-split-intranet.conf.example
```

部署文档：

- 手动部署：<https://xiaolong-taiwan.github.io/XPayincus/deployment/manual-install>
- Nginx split：<https://xiaolong-taiwan.github.io/XPayincus/deployment/nginx>
- systemd：<https://xiaolong-taiwan.github.io/XPayincus/deployment/systemd>
- 环境变量：<https://xiaolong-taiwan.github.io/XPayincus/deployment/environment>

## 生产验证

上线后至少运行：

```bash
RUN_LIVE_CHECKS=0 pnpm verify:production

FRONTEND_URL=https://panel.example.com \
ADMIN_FRONTEND_URL=https://admin.example.com \
BACKEND_URL=http://10.0.0.12:3001 \
pnpm verify:split:host

ENV_FILE=/opt/xpayincus/.env \
FRONTEND_URL=https://panel.example.com \
ADMIN_FRONTEND_URL=https://admin.example.com \
BACKEND_URL=http://10.0.0.12:3001 \
pnpm verify:production

ENV_FILE=/opt/xpayincus/.env \
FRONTEND_URL=https://panel.example.com \
BACKEND_URL=http://10.0.0.12:3001 \
pnpm verify:log-header

REQUIRE_LIVE_PROOF_REFS=1 \
LIVE_PAYMENT_PROOF_REF=pay_provider_order_xxx \
LIVE_LOG_HEADER_PROOF_REF=nginx_access_redacted_xxx \
pnpm verify:final-acceptance
```

`pnpm verify:production` 会强制开启生产预检；`RUN_LIVE_CHECKS=0 pnpm verify:production` 只检查配置和构建前置条件，适合还没接入真实域名时使用。`pnpm verify:split:host` 覆盖用户端/后台分离入口、`/api` 代理和登录/权限 smoke。最终验收必须提供真实 proof ref，`LIVE_PAYMENT_PROOF_REF`、`LIVE_LOG_HEADER_PROOF_REF` 等占位文字必须替换为可追溯的生产证据。

验收文档：<https://xiaolong-taiwan.github.io/XPayincus/deployment/production-checklist>

## 后台 OTA

XPayincus 管理后台提供系统更新页面，接口前缀为 `/api/admin/system-update/*`。超级管理员可以检查 GitHub Release、读取 OTA manifest、下载匹配架构的 artifact、校验 SHA256、运行更新任务、查看日志并回滚。

推荐变量：

```dotenv
SYSTEM_UPDATE_ALLOWED_ADMIN_IDS=1
SYSTEM_UPDATE_LOG_DIR=/opt/xpayincus/update-logs
SYSTEM_UPDATE_STARTED_BY_USER_ID=1
SYSTEM_UPDATE_RELEASE_REPOSITORY=XiaoLong-Taiwan/XPayincus
SYSTEM_UPDATE_APPLY_MODE=auto
XPAYINCUS_AGENT_RELEASE_REPOSITORY=XiaoLong-Taiwan/XPayincus-Agent
```

原子 OTA 布局：

```text
/opt/xpayincus/current -> /opt/xpayincus/releases/<version-timestamp>
/opt/xpayincus/releases/
/opt/xpayincus/update-logs/
```

OTA 文档：<https://xiaolong-taiwan.github.io/XPayincus/guide/ota-update>

## Public API

Public API 前缀是 `/api/v1`，并提供：

- `GET /api/v1/openapi.json`
- `GET /api/v1/openapi.yaml`
- `GET /api/v1/me`
- `GET /api/v1/products`
- `GET /api/v1/services`
- `POST /api/v1/services/:id/actions`
- `POST /api/v1/services/:id/renew`
- `GET /api/v1/orders`
- `GET /api/v1/billing-records`
- `GET /api/v1/tickets`
- `POST /api/v1/tickets`

认证方式：

```http
Authorization: Bearer pat_xxx
Authorization: Bearer poa_xxx
```

API 文档：<https://xiaolong-taiwan.github.io/XPayincus/api/overview>

TypeScript SDK：<https://xiaolong-taiwan.github.io/XPayincus/sdk/payincus-public-api.ts>

## 开发命令

```bash
pnpm install
pnpm dev
pnpm --filter client type-check
pnpm --filter server type-check
pnpm --filter client build
pnpm --filter server build
pnpm --dir docs-site --ignore-workspace build
```

常用守卫：

```bash
pnpm --filter server test:frontend-dist-boundary-guards
pnpm --filter server test:frontend-route-guards
pnpm --filter server test:frontend-i18n-keys
pnpm --filter server test:system-update-guards
pnpm --filter server test:public-api-openapi-guards
```

## 安全边界

- 用户端不能暴露后台入口和后台 API。
- 管理后台 API 必须经过管理员认证。
- Public API 只开放白名单字段、scope 和受控动作。
- 支付回调必须校验签名、订单状态、金额、过期时间和幂等。
- 文件上传限制 MIME、扩展名、大小、路径和访问权限。
- 生产日志和 proof 脚本必须脱敏密钥、Token、Cookie、数据库地址和用户隐私。

## 许可证

本仓库按 [LICENSE](./LICENSE) 发布。生产使用和商业运营前，请确认你的业务场景满足许可证、支付渠道、数据合规和当地法律要求。
