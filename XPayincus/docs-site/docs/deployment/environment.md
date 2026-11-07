# 环境变量

宿主部署的正式環境變數保存在 `/opt/incudal/.env`，面板來源位於統一倉 `XPayincus/`。宿主安裝器會產生多數值；手動部署可參考面板 `.env.example`。

Compose 使用 `XPayincus/deploy/compose/.env` 與 `secrets/`，由 `panel.sh init` 產生。不要直接套用下方宿主 loopback DB／API 位址；容器內 loopback 不是宿主。額外 Agent／Release 變數需以 override 等方式注入 API，僅填 Compose `.env` 不足。Compose 僅部署雙前端、單一 API 與 DB，宿主元件不容器化。所有模式只允許一個 Node API 程序。

Compose DB 匯出／匯入使用 `panel.sh export`、`panel.sh import ... --confirm-replace-incudal`。備份不含此處的金鑰、環境檔、憑證與實例資料，需另行安全保存。本次未執行檢查、備份還原或部署。

## 后端运行

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3001
TRUST_PROXY=true
SERVE_STATIC_CLIENT=false
```

生产必须设置 `SERVE_STATIC_CLIENT=false`，前端静态文件由 Nginx 托管。

## 公网地址

```dotenv
FRONTEND_URL=https://panel.example.com
ADMIN_FRONTEND_URL=https://admin.example.com
SITE_URL=https://panel.example.com
PAYMENT_CALLBACK_BASE_URL=https://panel.example.com
```

规则：

- `FRONTEND_URL` 是用户端域名。
- `ADMIN_FRONTEND_URL` 是管理后台域名，必须和用户端分离。
- `SITE_URL` 通常等于用户端域名。
- `PAYMENT_CALLBACK_BASE_URL` 通常等于用户端域名，支付商回调不要指向后台域名或内网地址。

## 前端构建变量

```dotenv
VITE_API_BASE_URL=/api
VITE_CUSTOMER_BASE_URL=https://panel.example.com
VITE_ADMIN_BASE_URL=https://admin.example.com
```

两个前端都通过同源 `/api` 和 `/api/ws` 访问后端。

## 数据库和缓存

```dotenv
DATABASE_URL=postgresql://incudal:change_me@127.0.0.1:5432/incudal
REDIS_URL=redis://:change_me@127.0.0.1:6379
```

PostgreSQL 是核心持久化來源。`REDIS_URL` 僅屬歷史安裝器相容設定，核心不依賴 Redis，Compose 不部署 Redis。PG advisory lock 不共享程序內防重放與快取狀態，不能據此啟用多 API 副本。

## Agent 發行來源

```dotenv
INCUDAL_RELEASE_REPOSITORY=owner/unified-repository
INCUDAL_AGENT_RELEASE_REPOSITORY=
INCUDAL_AGENT_RELEASE_TAG_PREFIX=
INCUDAL_AGENT_RELEASE_TOKEN=
```

舊 Agent repository 非空時優先。前綴未設定時舊來源為 `agent-`、統一來源為空；明確空值表示 `v*`。遠端 Release 需包含兩架構未壓縮二進位，僅有 `.gz` 或 Actions artifacts 不足。下載維持面板同源代理，token 僅保留在面板；詳細離線格式見 [Agent 安裝](/agent/install)。

## Cookie

```dotenv
COOKIE_SAME_SITE=
COOKIE_SECURE=
COOKIE_DOMAIN=
```

`COOKIE_DOMAIN` 必须保持空值，用户端和管理后台子域不能共享 refresh cookie。

## 安全密钥

```dotenv
JWT_SECRET=change_me_generate_with_openssl_rand_base64_48
COOKIE_SECRET=change_me_generate_with_openssl_rand_base64_48
ENCRYPTION_KEY=change_me_generate_with_openssl_rand_base64_48
ADMIN_EMAIL=admin@xpayincus.local
ADMIN_PASSWORD=change_me_admin_password
```

生产不要设置 `RESET_DATABASE`。密钥不要写入截图、工单、日志或公开文档。

## 支付回调

```dotenv
PAYMENT_CALLBACK_IP_WHITELIST=
PAYMENT_CALLBACK_IP_WHITELIST_REQUIRED=true
PAYMENT_CALLBACK_SKIP_IP_WHITELIST=false
```

生产建议配置支付商回调 IP 白名单。若支付商无法提供固定回调 IP，且运营方明确接受不使用来源 IP 白名单，则设置 `PAYMENT_CALLBACK_IP_WHITELIST_REQUIRED=false`，同时保持 `PAYMENT_CALLBACK_SKIP_IP_WHITELIST=false`。这表示不跳过已有白名单校验，只是在没有可用固定来源 IP 时接受空白名单；回调仍必须通过签名验签、交易状态、金额匹配和 `payment_callbacks` 幂等校验后才会入账。

## 后台 OTA

以下僅適用 systemd／sudo 宿主部署，Compose 不使用此 OTA。統一倉根 workflow 僅上傳 Actions artifacts，使用遠端 OTA 前必須另外發布面板資產與 `ota-manifest.json`。舊 Git updater 假設來源根就是面板根，不能推定 `git` 或 `auto` fallback 可直接使用統一倉 tag；建議使用已發布的 `artifact` 模式並先隔離驗收。程式回滾不還原資料庫 migration，詳見 [OTA 指南](/guide/ota-update)。

```dotenv
SYSTEM_UPDATE_ALLOWED_ADMIN_IDS=1
SYSTEM_UPDATE_LOG_DIR=/opt/incudal/update-logs
SYSTEM_UPDATE_STARTED_BY_USER_ID=1
SYSTEM_UPDATE_RELEASE_REPOSITORY=owner/unified-repository
SYSTEM_UPDATE_RELEASE_TOKEN=
SYSTEM_UPDATE_APPLY_MODE=auto
SYSTEM_UPDATE_MIN_FREE_MB=4096
SYSTEM_UPDATE_RELEASES_KEEP=8
SYSTEM_UPDATE_BACKUP_TASKS_KEEP=3
```

`SYSTEM_UPDATE_APPLY_MODE` 可选：

- `auto`：优先使用 Release artifact，缺失时回退 Git 构建。
- `artifact`：只允许校验过的 OTA artifact。
- `git`：强制 checkout tag 并在服务器构建。

## 验证

```bash
ENV_FILE=/opt/incudal/.env \
FRONTEND_URL=https://panel.example.com \
ADMIN_FRONTEND_URL=https://admin.example.com \
BACKEND_URL=http://127.0.0.1:3001 \
pnpm verify:production
```

宿主部署可先執行僅檢查設定的模式；此模式不提供 DB 或線上驗收證據：

```bash
RUN_LIVE_CHECKS=0 pnpm verify:production
```

最終驗收使用以下入口，會強制開啟生產預檢、登入／權限 smoke、Agent release smoke 與日誌／標頭檢查，並要求 `REQUIRE_LIVE_PROOF_REFS=1`：

```bash
LIVE_ACCEPTANCE_REPORT=/srv/private-reports/live-acceptance.md \
LIVE_PAYMENT_PROOF_REF='<真實支付證據引用>' \
LIVE_LOG_HEADER_PROOF_REF='<日誌與標頭證據引用>' \
pnpm verify:final-acceptance
```

佔位文字必須替換為實際證據，並依腳本要求補齊其餘 `LIVE_*_PROOF_REF`；只有自動檢查通過不代表完成正式驗收。上述命令適用既有宿主部署，不能直接套用於 Compose；執行前須準備受控測試帳號、可寫報告目錄與變更窗口。本次未執行這些命令。
