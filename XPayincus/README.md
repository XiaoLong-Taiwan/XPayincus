# XPayincus Dashboard 與 Server API

## 最簡部署指令

在 Linux 面板主機準備 DNS、HTTPS 與 Docker Compose，以 root 下載並執行統一管理入口，再從選單選擇「安裝新面板」及 Compose：

```bash
( f=$(mktemp) && trap 'rm -f "$f"' EXIT && curl -q -fsSL --proto '=https' --proto-redir '=https' https://raw.githubusercontent.com/XiaoLong-Taiwan/XPayincus/main/scripts/dashboard.sh -o "$f" && bash -n "$f" && bash "$f" )
```

安裝流程會要求部署目錄、使用者／管理端 HTTPS origin 及代理模式。操作既有部署前，先確認路徑是自己管理且信任的部署。完整安裝與最低需求見 [根 README](../README.md#最低需求與容量規劃) 及 [Compose 說明](deploy/compose/README.md)。

面向 Incus 的 NAT VPS 銷售、資源交付、支付帳務、Public API 與管理平台。此目錄是統一倉庫的 Server 端 pnpm workspace；整體版本以 [根 VERSION](../VERSION) 為準，目前來源樹目標為 `v1.0.26`（發布狀態以 GitHub Release 為準）。

本輪版本摘要：Dashboard／API、Agent、Compose 映像與 OCI labels 統一升至 `v1.0.26`；最低 updater 維持 v1.0.3。GitHub Actions、已發布資產與目標環境驗收是不同證據，請分別核對對應 commit、Release 與部署紀錄。

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

面板提供 Incus LXC／KVM 管理、NAT 與流量、方案購買與續費、錢包與訂單、支付回調、工單通知、管理後台、OAuth 及 `/api/v1` Public API。Agent 以 HMAC 心跳回報宿主資源、實例狀態和流量，並建立出站 WSS 隧道，將已認證的面板管理請求轉送至固定本機 Incus socket 與 Caddy admin API；協定與限制見 [隧道說明](../XPayincus-Agent/TUNNEL.md)。

歷史版本已移除插件／主題平台等模組，舊 release notes 中的功能僅代表當時狀態。API 實際行為以 `server/src/routes` 與 OpenAPI 為準。

## 部署與架構邊界

Dashboard 小型部署可先以 **2 vCPU、4 GiB RAM、40 GiB SSD** 作為建議起點，備份空間另計。這是未經壓力測試的容量建議，不是安裝硬門檻或效能保證；請依使用量、DB／WAL、日誌與更新暫存空間調整。來源建置另需評估記憶體與磁碟峰值，宿主 Incus／Agent／實例資源也須另外規劃。

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

既有宿主部署保留 `scripts/install-panel.sh`、`deploy/` 下的 systemd 與 Nginx 模板，支援 `/opt/incudal/current -> releases/<version-timestamp>` 原子布局。安裝器已使用統一倉庫 `XiaoLong-Taiwan/XPayincus` 的 Release，並檢查 checksum 與封存內容。`scripts/dashboard.sh --host-install` 僅供最新正式版全新原生安裝，會要求 root 與互動確認，遇到既有 `/opt/incudal` 直接拒絕；既有原生部署請走 [原生 OTA](docs-site/docs/guide/ota-update.md#原生-systemd-ota)。手動部署請依 [指南](docs-site/docs/deployment/manual-install.md) 選用已發布且校驗的面板資產；反向代理見 [部署文件](docs-site/docs/deployment/nginx.md)。

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

執行前需準備相應資料庫、工具鏈與本地設定；實際通過項目以對應執行紀錄為準。部署文件守衛可獨立執行 `pnpm --dir docs-site check:deployment`。

## 統一發行與 OTA

正式入口為根 `.github/workflows/ci.yml`、`.github/workflows/release.yml`，子目錄 workflow 保留歷史參考。根 release workflow 在相符的 `v*` tag 推送後自動發布 GitHub Release，手動觸發僅產生 Actions artifacts，不自動部署。版本、兩架構原生依賴、資產清單與發布要求見 [統一發行說明](../RELEASE.md)。

### Compose 一般更新與除錯

以下從統一倉庫根目錄執行；`/srv/incudal-panel` 須是自己管理且信任的既有 Compose 部署絕對路徑，新入口會執行該目錄的 `panel.sh`，不會替舊部署補齊缺少的指令：

```bash
bash scripts/dashboard.sh doctor /srv/incudal-panel --json
bash scripts/dashboard.sh update-plan /srv/incudal-panel
# 核對計畫並另外安全備份設定、密鑰與憑證後，執行一般更新
bash scripts/dashboard.sh update /srv/incudal-panel
```

`update-plan` 取得操作鎖、下載並驗證目前及目標官方部署檔與容器身分，不備份、不切換、不停機，也不改 journal；會建立鎖與暫存目錄。`update` 固定最新正式 Release，拒絕自動降版，備份 DB／部署檔、寫入持久 journal，再切換部署工具並啟動。映像準備完成後才停止舊服務；migration 或健康檢查失敗時不保證服務仍運行，也不自動回滾 DB。

```bash
bash scripts/dashboard.sh recover /srv/incudal-panel --json
bash /srv/incudal-panel/panel.sh status
bash /srv/incudal-panel/panel.sh logs api
# 僅需修復目前釘選版本的容器時，先備份再重建
bash scripts/dashboard.sh force-recreate /srv/incudal-panel
```

`doctor` 與預設 `recover` 是唯讀診斷，不建立鎖或狀態目錄；doctor 的 ledger／health 通過不代表 schema 相容或完成上線驗收。未完成更新會阻擋新更新，先保留 journal 與備份並核對恢復指引；`recover --retry-preflight` 僅限 `backupComplete=false` 且已修正原因，`recover --resume-up` 僅限備份可驗證、目前為目標版本，並人工確認設定與 schema 相容。兩者都會持鎖且不還原 DB；選單中須先選 `[0]` 退出再執行提示命令。

`force-recreate` 等同 `bash /srv/incudal-panel/panel.sh up pull --force-recreate`，保留 DB／設定／密鑰，但有短暫停機，且啟動時可能執行 migration。它只重建目前釘選版本，不查詢 latest、不跨版更新、不回滾資料庫。需要換版使用 `update`；只有拉取映像、不停啟服務使用 `panel.sh pull`。更多備份與除錯限制見 [Compose 指南](deploy/compose/README.md)。

### 原生 systemd 與 Agent

原生 systemd／sudo OTA 使用 `/api/admin/system-update/*`，由超級管理員執行，流程與命令見 [OTA 指南](docs-site/docs/guide/ota-update.md#原生-systemd-ota)。Compose 禁止此更新與回滾入口。

Agent 的 `reinstall`／安裝器 `--reinstall` 保留既有設定，沒有 `--force`；未指定 `--version` 時仍選擇 `latest`，可能升版，不會自動固定目前版本。同版修復必須先確認已安裝版本，再以 `--version` 指定該版本。升版請使用 Agent `update` 並核對目標版本及面板相容性。Dashboard 容器重建不會重裝 Agent、Incus、RFW 或 ZFS。

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

[文件站](docs-site/README.md) 提供部署、Agent、管理端與 API 文件。`HANDOFF.md`、`OPERATIONS_HANDOFF.md`、`audits/` 及歷史 release notes 保留歷史證據，不代表目前 checkout、CI、Release 或線上狀態。文件描述可用流程，不替代目標 Linux 主機上的更新、還原與功能驗收；分享診斷輸出前須移除敏感資訊。

面板程式的授權見 [LICENSE](LICENSE)；其他元件依各自授權文件。
