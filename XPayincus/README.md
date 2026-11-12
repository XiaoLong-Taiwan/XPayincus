# XPayincus Dashboard 與 Server API

面向 Incus 的 NAT VPS 銷售、資源交付、支付帳務、Public API 與管理平台。此目錄是統一倉庫的 Server 端 pnpm workspace；整體版本以 [根 VERSION](../VERSION) 為準，本次發行目標為 `v1.0.13`（v1.0.12 已正式發布，發布狀態以 GitHub Release 為準）。歷史交接檔中的線上版本不代表統一版本已部署。

本輪同步 v1.0.13 產品版本、Compose 標籤與發布記錄，詳見 [v1.0.13 發行目標](../RELEASE.md#v1013-發行目標)。v1.0.12 的 Agent 監控、網路探測及 Compose 備份功能保留於歷史紀錄；跨版本升級仍須交付完整 migration。此次驗證限版本契約與靜態核對，完整測試、建置及真機驗收待後續執行。

## 目錄與能力

| 路徑（相對本目錄） | 用途 |
| --- | --- |
| `client/` | Vue 3 + Vite，使用者／管理端雙入口，輸出 `client/dist/user`、`client/dist/admin` |
| `server/` | Fastify + Prisma + PostgreSQL，API、鑑權、帳務與排程 |
| `server/prisma/` | schema 與 migrations |
| `server/templates/` | 宿主安裝、Agent 與憑證模板 |
| `deploy/compose/` | 面板容器部署、反向代理範例及資料庫 CLI |
| `scripts/` | 安裝、OTA、守衛與維運腳本；可用性須以實際檔案為準 |
| `docs-site/` | 獨立 VitePress 文件 package |
| `../XPayincus-Agent/` | Go 宿主監控與自升級元件 |
| `../XPayincus-Agent/components/rfw/`、`../XPayincus-Agent/components/zfs/` | 宿主防火牆與儲存建置元件；Go Agent 不直接載入核心模組 |

面板提供 Incus LXC／KVM 管理、NAT 與流量、方案購買與續費、錢包與訂單、支付回調、工單通知、管理後台、OAuth 及 `/api/v1` Public API。Agent 以 HMAC 心跳回報宿主資源、實例狀態和流量；不執行建立、銷毀或啟停實例的下發任務。

歷史版本已移除插件／主題平台等模組，舊 release notes 中的功能僅代表當時狀態。API 實際行為以 `server/src/routes` 與 OpenAPI 為準。

## 部署與架構邊界

新面板部署可使用 [Compose 說明](deploy/compose/README.md)，從統一倉庫根目錄執行：

```bash
cd XPayincus
bash deploy/compose/panel.sh init https://pay.example.org https://admin.example.org admin@example.org
bash deploy/compose/panel.sh up build
```

Compose 只包含 PostgreSQL 16、單一 API 與雙前端，不部署 Incus、Agent、RFW 或 ZFS，也不需要 Redis。以 `docker-compose.yml` 引用 `compose.yaml`，支援 Nginx（預設）、Cloudflare Tunnel 或外部 HTTPS 代理；前端預設監聽 `127.0.0.1:3000`、`127.0.0.1:3001`，API 與 DB 不發布宿主埠。容器內 `127.0.0.1` 不是宿主 Incus 端點。

所有部署都必須遵守：

- 使用者與管理端使用不同 origin；`FRONTEND_URL`、`ADMIN_FRONTEND_URL` 分別設定，`COOKIE_DOMAIN` 保持空值，不能共享 refresh cookie。
- 兩端透過各自同源 `/api` 與 `/api/ws` 存取同一個後端。正式環境使用 `SERVE_STATIC_CLIENT=false`。
- API 只能執行一個 Node 程序。禁止 cluster、多 worker、多容器副本，或與舊 systemd 程序同時連線至相同 DB；PG advisory lock 不會共享程序內的防重放、鎖與快取狀態。
- DB archive 不含 `.env`、加密金鑰、Incus 客戶端憑證或實例資料，移機須另外安全保存。

既有宿主部署保留 `scripts/install-panel.sh`、`deploy/` 下的 systemd 與 Nginx 模板，支援 `/opt/incudal/current -> releases/<version-timestamp>` 原子布局。安裝器仍固定使用歷史獨立倉庫的 Release，不能僅靠搬移腳本就視為已支援統一發行來源。統一來源部署請依 [手動部署](docs-site/docs/deployment/manual-install.md) 選用已實際發布且校驗的面板資產；反向代理見 [部署文件](docs-site/docs/deployment/nginx.md)。

## CLI 備份與還原

以下在本目錄執行，僅操作此 Compose 的 PostgreSQL 16。目的父目錄須已存在，匯出不得覆寫檔案：

```bash
bash deploy/compose/panel.sh export /srv/private-backups/panel.dump
bash deploy/compose/panel.sh import /srv/private-backups/panel.dump --confirm-replace-incudal
```

CLI 沒有對應的新管理面板按鈕。匯入僅限可信 custom／tar archive；會先停面板與 API，再保留還原前備份，以單一交易還原。成功或失敗均維持面板停止，確認程式版本、金鑰及憑證後手動 `up`。備份未加密，需另行加密並離機保存。完整限制見 Compose 說明。

舊無 Docker 宿主可使用自 v1.0.2 提供的 `server/scripts/export-legacy-host.mjs`，匯出 DB、設定、原密鑰及憑證；工具不自動停止服務或切換部署。工具與 [首次匯入指南](server/scripts/LEGACY_HOST_EXPORT.md) 隨原生 Panel 及 Dashboard Compose 來源包交付，首次啟動前須保留原加密金鑰、核對 schema 相容性並停止舊寫入端。

## 開發與檢查命令

需要 Node.js 20+（建置流程使用 22）、pnpm 9.14.2 與 PostgreSQL 16。以下為 Bash 指令，在 `XPayincus/` 執行，先依 `.env.example` 準備本地設定：

```bash
pnpm install --frozen-lockfile
pnpm --filter server exec prisma generate
pnpm dev
```

開發 API 為 `127.0.0.1:3001`，使用者端 3000、管理端 3002。`pnpm dev` 的預設 secret 僅供本地開發，不能用於正式環境。

```bash
pnpm --filter client type-check
pnpm --filter server type-check
pnpm test
pnpm build
pnpm test:agent
pnpm docs:dev
pnpm docs:build
```

這些是操作參考，本次未執行；執行前需準備相應資料庫、工具鏈與本地設定。

## 統一發行與 OTA

正式入口為根 `.github/workflows/ci.yml`、`.github/workflows/release.yml`，子目錄 workflow 保留歷史參考。根 release workflow 在相符的 `v*` tag 推送後自動發布 GitHub Release，手動觸發僅產生 Actions artifacts，不自動部署。版本、兩架構原生依賴、資產清單與發布要求見 [統一發行說明](../RELEASE.md)。

舊宿主部署的 OTA 使用 `/api/admin/system-update/*`，由超級管理員執行；Compose 不支援容器內 systemd／sudo 更新。Compose 應先備份，選定來源版本後執行 `panel.sh up` 重建，migration 不會自動回滾。

統一 Release 來源可在面板設定：

```dotenv
INCUDAL_RELEASE_REPOSITORY=owner/unified-repository
INCUDAL_AGENT_RELEASE_REPOSITORY=
INCUDAL_AGENT_RELEASE_TAG_PREFIX=
SYSTEM_UPDATE_RELEASE_REPOSITORY=owner/unified-repository
```

舊 Agent repository 非空時優先；未設定前綴時舊來源使用 `agent-`，統一來源使用空前綴。明確空值代表 `v*` tag。面板 OTA repository 需獨立設定。Compose 需另以部署設定將變數傳入 API 容器，不能只填 Compose `.env`。

Agent 仍走面板同源 manifest／binary 代理，私有來源 token 只放面板。遠端 Release 必須有 amd64、arm64 兩個未壓縮 Agent 二進位；僅有 `.gz`、manifest、tag 或 Actions artifact 不足以安裝與更新。詳見 [Agent 說明](../XPayincus-Agent/README.md) 與 [OTA 文件](docs-site/docs/guide/ota-update.md)。

## 文件與證據

[文件站](docs-site/README.md) 提供部署、Agent、管理端與 API 文件。`HANDOFF.md`、`OPERATIONS_HANDOFF.md`、`audits/` 及歷史 release notes 保留歷史證據，不代表目前 checkout、CI、Release 或線上狀態。本次只整理文件，未執行測試、建置、OTA 或實機驗收。

面板程式的授權見 [LICENSE](LICENSE)；其他元件依各自授權文件。
