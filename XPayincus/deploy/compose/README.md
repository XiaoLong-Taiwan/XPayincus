# 面板 Compose v1.0.2 部署與 PostgreSQL 匯出匯入

本配置僅部署 Dashboard／面板：使用者前端、管理端前端、單一 API 程序及 PostgreSQL 16。Agent、Incus、ZFS、RFW 與宿主機網路服務維持既有宿主機部署，不提供容器、不掛載 Docker socket、不使用 privileged 或 host network。原 systemd／Nginx 配置保留；發行入口是統一倉庫根 `.github/workflows`，子目錄 workflow 僅作歷史參考。

本文件描述統一版 v1.0.2 的 Compose 配置；整體發行版本以根 `VERSION` 為準。根封裝腳本會核對新入口、Nginx 模板、支援腳本與 legacy export 工具／指南完整性。GitHub CI 包含 Compose 的 API／雙前端映像建置，不推送 registry，也不自動部署；完整發行規則見根 [RELEASE.md](../../../RELEASE.md)。

## 前置條件

- Linux 主機，Bash、OpenSSL、util-linux `flock`、GNU coreutils／tar／find／awk、Docker Engine 與 Compose v2.20.0 以上外掛；需要 `include`、`up --wait --wait-timeout`、`service_completed_successfully` 與 bind mount 的 `create_host_path: false`，不支援舊版 `docker-compose` v1。操作帳號須能存取 Docker daemon 並讀寫部署目錄，初始化與後續操作請使用同一帳號。
- 完整面板原始碼與既有 pnpm lockfile；建置需存取容器 registry、Debian 套件來源、npm registry 與 Prisma engine 下載來源。建置階段使用 Node 22、pnpm 9.14.2，執行既有前後端 build；宿主機不必安裝 Node、pnpm 或 PostgreSQL。
- 兩個不同 hostname 的 HTTPS origin 與 DNS。選擇自搭 Nginx 時準備 TLS 憑證；選擇 Cloudflare Tunnel 時準備 remotely-managed tunnel。Dashboard／管理端預設為 `127.0.0.1:3000`／`127.0.0.1:3001`，API 的容器內部 3001 不發布至宿主機。
- 僅部署一套 `incudal-panel`。API 固定容器名稱，禁止 `--scale api=2`、額外 Compose project 或與舊 systemd 後端同時連線至同一 DB。API 的程序內狀態要求單實例。

Windows 工作區可編輯這些檔案；部署 CLI 應在 Linux 主機或具有 Docker 存取權的 WSL Linux 檔案系統執行，並使用 LF 換行。不要透過 PowerShell 5 的文字重導向處理二進位備份。

### 原始碼與必要檔案

可使用完整倉庫，或解壓 Dashboard Compose 原始碼包 `xpayincus-dashboard-<版本>-compose.tar.gz`。包內須保留 `XPayincus/` 的相對目錄；**只複製 `deploy/compose/` 無法建置**。`compose.yaml` 的預設 build context `../..` 解析為 `XPayincus/`，不是統一倉庫根目錄；安裝模式改用 `BUILD_CONTEXT=./source`。這是原始碼建置部署，並非下載預先發布的面板映像。

根打包腳本 `scripts/package-dashboard-release.sh` 會透過 `prepare-compose-release.mjs` 在包內產生 `deploy/compose/compose.release.yaml`，為 `api`、`user`、`admin` 指定版本映像名稱與 `org.opencontainers.image.version` 建置標籤。此 override 保留原有 build 設定，`panel.sh up` 仍從包內原始碼建置映像。

主要入口為 `docker-compose.yml`，透過 Compose `include` 引用 `compose.yaml`；所有服務、網路、secret 僅定義於 `compose.yaml`，舊的 `-f compose.yaml` 用法仍相容。避免同時載入兩個入口。若存在 `compose.release.yaml`，CLI 使用 `compose.yaml` 再疊加該 override，避免 `include` 與 override 同名服務衝突；檔案必須可讀且非空。`init` 會寫入對應 `COMPOSE_FILE`，讓部署目錄的 `docker compose` 也採相同配置。`up`、`down`、`status`、`logs`、`export`、`import` 共用配置；`install`、`init` 與 help 不呼叫 Compose。

| 路徑（相對於 `XPayincus/`） | 用途 |
| --- | --- |
| `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` | 固定 workspace 與依賴版本，使用 frozen lockfile 安裝 |
| 完整 `client/` | 包含 package、Vite／TypeScript 設定、`index.html`、`src/`、`public/`，建置兩套獨立前端 |
| 完整 `server/` | 包含 package、TypeScript 設定、`src/`、Prisma config、schema 及完整 migration 歷史 |
| `server/templates/install.sh`、`agent-install.sh`、`caddy.sh` | API 提供的宿主安裝模板；仍由宿主執行，保留在 `server/templates/`，不靠 TypeScript 複製 |
| `server/scripts/export-legacy-host.mjs`、`LEGACY_HOST_EXPORT.md` | 舊宿主匯出工具與首次匯入指南，也隨原生 Panel 包交付 |
| `deploy/compose/Dockerfile`、`Dockerfile.dockerignore` | 多階段建置及專屬 build context 排除規則，兩檔皆須保留 |
| `deploy/compose/api-entrypoint.sh`、`nginx.conf.template` | API secret／migration／單程序啟動及雙前端 Nginx 路由 |
| `deploy/compose/docker-compose.yml`、`compose.yaml`、`panel.sh` | 主要入口、唯一服務定義與部署 CLI |
| `origin-entrypoint.sh`、`edge-nginx.conf.template`、`tunnel-nginx.conf.template` | 選用入口的 hostname 產生與可信來源 IP 轉送 |
| `https-proxy.conf.example` | 使用既有宿主 Nginx 的範例 |

API 映像保留根 `node_modules` 的 pnpm store、`server/node_modules` 連結、已產生的 Prisma client 與 Prisma CLI；不要只複製 `server/dist/`。建置用的 `DATABASE_URL` 為無實際資料庫的佔位 URL，供 Prisma generate 載入設定；建置不執行 migration、不需要正式 DB 密碼。

## 首次部署

1. 在 Linux 安裝 Docker Engine 與 Compose v2.20.0 以上外掛。Debian／Ubuntu 的其他前置工具可用 `sudo apt-get install bash openssl util-linux coreutils tar findutils gawk` 安裝。按所選模式準備 DNS、憑證或 Tunnel，並規劃建置、DB、WAL 及備份空間。
2. 確認 `docker version`、`docker compose version` 可用。建立空的部署目錄，從完整倉庫或來源包執行安裝；省略目的地時安裝至目前目錄：

```bash
mkdir -p /srv/incudal-panel
cd /srv/incudal-panel
bash /srv/longshang-xpayincus/XPayincus/deploy/compose/panel.sh install
bash panel.sh init https://pay.example.org https://admin.example.org admin@example.org
```

也可在來源目錄執行 `bash deploy/compose/panel.sh install /srv/incudal-panel`，再進入目的地操作。目的地必須為空且位於來源樹之外；安裝會複製 workspace 清單、lockfile、完整前後端及部署建置來源至 `./source/`，並在目的地建立 `panel.sh`、Compose 設定與文件入口，排除依賴、建置產物及原部署私密資料。不需要保留原來源路徑。複製失敗時目的地可能留下部分檔案，請檢查並改用另一個空目錄重試。

以下命令以安裝後的部署目錄為工作目錄，`./` 指該目錄，無論從何處呼叫 `panel.sh`，資料仍定位在腳本旁。若直接使用倉庫模式，改用 `bash deploy/compose/panel.sh`，資料則在 `XPayincus/deploy/compose/`，原有 `../..` build context 保持可用。

| 部署目錄路徑 | 用途 |
| --- | --- |
| `./source/` | 完整可建置來源，含 `source/deploy/compose/Dockerfile` 及其專屬 ignore |
| `./.env`、`./secrets/` | 私有配置、五個應用 secret，以及 Cloudflare 模式額外的 token file |
| `./tls/user/`、`./tls/admin/` | 自搭 Nginx 的 fullchain.pem 與 privkey.pem，唯讀掛載，不複製進來源或映像 |
| `./data/postgres/` | PostgreSQL 16 資料與 WAL，bind mount |
| `./certs/` | 面板連線 Incus 的憑證及私鑰，bind mount |
| `./config/` | API 可寫設定目錄，bind mount |
| `./backups/` | 預設 DB 匯出及匯入前備份，API 僅唯讀掛載 |
| `./.state/` | CLI 操作鎖 |

`init` 不連線資料庫、不建立容器。它以 `umask 077` 建立 `.env`、私有 `secrets/` 目錄及各自獨立的 PostgreSQL、JWT、cookie、加密與管理員密碼，拒絕覆蓋既有配置。初始帳號為 `admin`；密碼位於 `./secrets/admin_password`，不會印到終端。請在可信環境以安全方式讀取並保存。若初始化中斷，先檢查已建立的配置，勿任意重新產生或替換既有密鑰。

3. 如需改用其他 loopback 埠，啟動前編輯 `./.env` 的 `USER_PORT`／`ADMIN_PORT`，並同步修改宿主代理 upstream。不要先複製 `.env.example`，否則 `init` 會拒絕覆蓋；該檔僅為欄位參考。
4. **有既有 DB 要還原時，此時先還原原密鑰與憑證，再執行匯入，勿先執行 `up`。** 已保存整套原 `.env`／`secrets/` 時，直接安全複製回部署目錄並跳過 `init`；若先用 `init` 產生新配置，必須在啟動前以原值取代 `secrets/encryption_key`，並依「密鑰、憑證」節保留其他 secret 與憑證。然後執行：

```bash
bash panel.sh import /srv/private-backups/panel.dump --confirm-replace-incudal
```

匯入命令會停止既有面板，只啟動 DB 及其相依的 Compose `init` 服務，等待 DB 健康後還原；不建置或啟動 API，不執行 Prisma migration。還原前自動備份可能僅含空 DB。匯入成功後面板仍停止，確認資料、密鑰與版本相容後再繼續。

5. 依下一節設定所選 HTTPS 入口，然後啟動面板：

```bash
bash panel.sh up
bash panel.sh status
```

`up` 先檢查必要原始碼、部署檔及五個 secret 檔是否可讀且非空，再以 `docker compose config --quiet` 解析設定；檢查不輸出展開後的配置。接著建置映像，建置成功才停止既有面板與 API，再依序啟動 Compose `init`、DB、API、雙前端。Compose `init` 與 CLI 的 `init` 命令不同：容器服務建立資料目錄並設定權限，不產生密鑰、不執行 migration；PostgreSQL 目錄歸容器內 postgres、`certs/` 與 `config/` 歸 UID 1000、`backups/` 歸 `.env` 擁有者。API 先執行 `prisma migrate deploy`，成功後以非 root 的單一 Node 程序啟動。Dockerfile 會檢查雙前端首頁、後端入口及三份宿主模板均已存在。

Compose 啟動等待最長 300 秒，包含 DB／API 健康檢查及兩套 Nginx 的 `/index.html` HTTP 檢查；這不代表已完成 TLS、登入或瀏覽器端驗收。Migration 失敗時前端不會重新開放；修正原因後再執行 `up`。Migration 可能修改資料，升級前請先匯出備份。超時或 unhealthy 不會自動回滾或停止整套服務，先查看 `status`、`logs init` 與 `logs api`，勿直接清除 `data/postgres/`。

### HTTPS 與容器網路

`init` 的第四個參數可選 `nginx`（預設）、`cloudflare` 或 `external`；它分別寫入 `.env` 的 `COMPOSE_PROFILES=nginx`、`COMPOSE_PROFILES=cloudflare` 或空值。也可初始化後編輯 `.env`。CLI 僅接受這三種值；`up` 建置完成後停止舊入口，再按所選 profile 啟動，`down` 會涵蓋兩種 profile。直接使用 Compose 切換模式時，先以兩種 profile 執行 `down` 再啟動，避免舊服務留在運行中。

| 模式 | 啟動的選用服務 | 前置設定 |
| --- | --- | --- |
| `nginx` | `nginx` | 憑證置於 `./tls/user/`、`./tls/admin/`；公開 `${HTTPS_PORT:-443}` |
| `cloudflare` | `tunnel-origin`、`cloudflared` | token file 與 Cloudflare 公開 hostname 路由；不發布額外宿主埠 |
| 空值（`external`） | 無 | 自行管理宿主 Nginx，使用 loopback 3000／3001 |

自搭 Nginx 使用兩個公開 hostname 分流，直接以 socket 來源覆寫 `X-Real-IP`。憑證簽發、續期由操作人員管理；更換憑證後重啟 `nginx`。若公開 origin 使用非預設 HTTPS 埠，將 `HTTPS_PORT` 設為相符埠。預設不開啟 HTTP 80。若使用既有宿主 Nginx，選 `external` 以免爭用 443。

Cloudflare 模式可使用：

```bash
bash panel.sh init https://pay.example.org https://admin.example.org admin@example.org cloudflare
```

以安全編輯器建立 `./secrets/cloudflare_tunnel_token`，只寫入 token 本身，再執行 `chmod 600 ./secrets/cloudflare_tunnel_token`。CLI 不接受 token 引數、不讀出或列印其內容；Compose 使用 file secret 掛入 `/run/secrets/cloudflare_tunnel_token`，cloudflared 透過 `--token-file` 讀取。不要把 token 放入 `.env`、shell history 或日誌；不要開啟 shell trace 或 cloudflared debug。cloudflared 以 root 讀取 600 file secret，但 drop 全部 capabilities、禁止新增權限並使用唯讀 root filesystem。此映像使用 `latest`，正式部署可由操作人員鎖定已驗證 digest。

在 Cloudflare 的 remotely-managed tunnel 設定兩筆 Public Hostname：`pay.example.org` 與 `admin.example.org`，兩者的 Service 都設為 `http://tunnel-origin:80`，保留原始 Host，不設定共同的 HTTP Host Header override；啟用公開 HTTPS 轉址及 WebSocket。不可指向 API。`tunnel-origin` 無宿主 ports，只在容器網路接收 cloudflared，依 hostname 分流至兩前端並使用 `CF-Connecting-IP` 覆寫來源 IP；不要將這個入口發布至不可信網路。首次連線、DNS／TLS 與來源 IP 仍需在目標環境驗收。

Compose 的 DB 與 API 不發布宿主機埠；DB 使用 internal network，API 另有對外網路以連線既有宿主機及第三方服務。只有雙前端 HTTP 埠發布至 loopback。Docker 網路及防火牆必須允許 API 到既有 Incus／Agent 相關端點，宿主機端點不可填容器內的 `127.0.0.1`。

將 [https-proxy.conf.example](./https-proxy.conf.example) 的網域與憑證路徑替換後，整合至宿主機 Nginx。該檔案放在 Nginx `http` context；TLS 憑證簽發、續期、80→443 轉址及正式網域限制由宿主機管理。管理端可再加 VPN 或來源 IP 限制。必須由這層代理**覆寫** `X-Real-IP`，容器 Nginx 僅轉送該可信值，避免客戶端偽造付款白名單或限流所使用的 IP。若前方還有 CDN，先在宿主機按 CDN 官方網段設定 real-IP 信任範圍，不能直接信任任意來源 header。

Nginx 範例的 upstream 為 HTTP，不能改成容器的 HTTPS 埠；若公開 origin 使用非預設埠，也須同步調整宿主 `listen`。在部署主機完成設定後執行 `sudo nginx -t`，確認成功再執行 `sudo systemctl reload nginx`。這兩個命令由操作人員在目標主機執行，CLI 不修改宿主代理。

本配置固定 HTTPS cookies、host-only cookies 與同源 `/api`，包含 WebSocket upgrade；不要直接透過 HTTP localhost 登入。若更改 `.env` 中的公開 URL，執行 `up` 重建前端，因跨面板連結是建置時注入。

### 設定欄位與日常操作

| `.env` 欄位 | 說明 |
| --- | --- |
| `FRONTEND_URL`、`ADMIN_FRONTEND_URL` | 不同的 HTTPS origin，無路徑或尾斜線；用於 CORS、公開 URL 及建置時跨面板連結 |
| `ADMIN_EMAIL` | 首次建立 `admin` 的電子郵件；改值不會覆蓋既有管理員資料 |
| `USER_PORT`、`ADMIN_PORT` | 不同且未占用的宿主 loopback TCP 埠，預設 3000／3001 |
| `COMPOSE_PROFILES` | `nginx`、`cloudflare` 或空值；不要同時啟用兩種入口 |
| `COMPOSE_FILE` | 預設 `docker-compose.yml`；發行 override 存在時為 `compose.yaml:compose.release.yaml`（Linux） |
| `BUILD_CONTEXT` | 倉庫模式 `../..`、安裝模式 `./source`，由 init 自動填入 |
| `HTTPS_PORT` | 自搭 Nginx 對外 HTTPS 埠，預設 443 |
| `INCUDAL_RELEASE_REPOSITORY`、`INCUDAL_AGENT_RELEASE_REPOSITORY` | 可選的 Agent 資產來源 `owner/repo`；依既有 Agent 來源解析規則使用，不啟用面板 OTA |

`.env` 只供 Compose 插值，不會整份注入 API。額外 API 變數須明確加入部署設定；密碼與金鑰仍放 `secrets/`。避免在執行 shell 預先匯出同名變數，因 shell 的值優先於 `--env-file`。API 的 root entrypoint 只負責載入 secret、設定憑證目錄權限，再交由 UID 1000 執行 migration 與 Node；不要直接改成 `user: node`，否則無法讀取私有 file secrets 或修正 volume 權限。

```bash
bash panel.sh status
bash panel.sh logs
bash panel.sh logs init
bash panel.sh logs api
bash panel.sh down
```

`status` 包含已退出的容器，`logs` 顯示全部或指定服務最近 100 行且不持續追蹤。分享日誌前先移除敏感資料。`down` 保留部署目錄內的 bind mount 資料；不要刪除資料目錄，也不要使用 `docker compose down -v`，仍待遷移的舊 named volumes 可能因此被刪除。CLI 固定 project 名稱及 Compose 路徑，可從其他目錄使用腳本絕對路徑執行。所有 CLI 操作使用同一把非阻塞鎖；直接呼叫 Docker 或其他專案副本不受這把鎖保護。

初始化後，在部署目錄可直接使用 Compose；`.env` 的 `COMPOSE_FILE` 與 `BUILD_CONTEXT` 已指向相同來源：

```bash
docker compose --profile nginx --profile cloudflare ps --all
docker compose up -d --build --wait --wait-timeout 300
```

建議使用 `panel.sh up`，其包含 secret／憑證檢查、互斥 profile 限制及停止舊入口。直接 Compose 不提供 CLI 操作鎖與這些前置保護。從舊配置升級時保留原 `.env`／secrets，補上 `COMPOSE_PROFILES`、`COMPOSE_FILE` 與 `BUILD_CONTEXT`；未設定 profile 時維持原有宿主代理模式。既有 USER_PORT／ADMIN_PORT 值繼續生效，不會自動改寫。

### 部署驗收與排查

以下命令供操作人員在目標 Linux 主機部署後執行：

```bash
curl --fail --silent --show-error https://pay.example.org/api/health
curl --fail --silent --show-error https://admin.example.org/api/health
```

再以瀏覽器確認兩端頁面、管理員登入與 WebSocket 終端；檢查使用者端不載入管理端入口，並確認 API 可連到目標 Incus。付款回呼與來源 IP 白名單須按實際付款來源設定，不可為了通過驗收關閉白名單。

| 現象 | 排查方向 |
| --- | --- |
| `init` 拒絕覆蓋 | 檢查是否已有 `.env`／`secrets/`，既有部署保留原檔，不重新初始化 |
| build 缺檔或 lockfile 不符 | 使用完整原始碼及同版本 lockfile，保留 `Dockerfile.dockerignore`；檢查 registry／Prisma 下載連線 |
| API restart／migration 錯誤 | `panel.sh logs api`、`logs db`、`logs init`；確認 DB 密碼與既有資料相符及完整 migration 歷史，不跳過 migration |
| 健康檢查超時 | `status` 查看含退出容器的狀態；Nginx 看 `logs user`／`logs admin`，API 看 migration 及啟動訊息 |
| HTTPS 502／登入失敗 | 核對宿主 upstream 埠、DNS／憑證、兩個 origin 與 secure cookie，確認已重建前端 |
| Incus 連線或憑證失敗 | 檢查容器到宿主的可路由位址、防火牆、`certs/` 內容與 UID 1000 讀取權限 |

不要用 `prisma db push --accept-data-loss`、刪除 migration 紀錄或清除 volume 來繞過啟動錯誤。若已有 DB migration 失敗，須先備份並診斷該 migration，再按 Prisma 的既有資料庫修復流程處理。

## 更新與移機

更新前記錄目前來源版本，安全保存 `.env`、整個 `secrets/`、`certs/`、`config/`，並執行下一節的 DB 匯出。`install` 不覆蓋既有部署；可將目標版本安裝到另一個空目錄，停止舊服務後安全搬移原設定與資料，或由操作人員在停機備份後更新原目錄的 `source/` 與部署入口。保留資料目錄及原密鑰，再執行 `panel.sh up`。同機更換部署目錄時先對舊部署執行 `down`，避免相同 project 的容器仍掛載舊路徑。只有在同一部署目錄原地更新時，建置期間舊 API 才可繼續運作，建置成功後進入停機更新。

使用發行包更新時保留目標包附帶的 `compose.release.yaml`，不要從舊版本複製該檔，避免將新原始碼標成舊版映像。它不含私人設定，不需由 `init` 產生。

歷史面板 v1.5.9 遷移至統一版 v1.0.x（含 v1.0.1）須受控遷移，不自動降版。先另行授權、備份資料庫與設定，核對 schema、部署方式、updater 版本及回復方案，再於隔離環境驗證；不可改寫目前版本或利用 Git fallback 繞過降版守衛。release channel 不代表資料庫相容。

移機時先在新主機準備完整原始碼、原配置與憑證，停止舊主機所有 API／worker，再於新主機只啟動 DB，匯入可信備份；不要先啟動 API 對待還原資料庫執行 migration：

```bash
bash panel.sh import /srv/private-backups/panel.dump --confirm-replace-incudal
bash panel.sh up
```

此時自動產生的 before-import 備份可能僅含空 DB。新主機須事先以安全離線流程還原 `certs/` 與 `config/`，確認 UID 1000 可讀取憑證及私鑰，再啟動 API。完成 HTTPS 與功能驗收後切換對外流量；全程只能有一個 API 執行背景任務。程式降版不會回復 schema，須搭配相容的 DB 備份及原金鑰，不提供自動回滾。

### 舊 named volume 遷移至目前目錄

新版使用 `./data/postgres` 與 `./certs` bind mounts，**不會自動讀取**舊 `incudal-panel_postgres_data`／`incudal-panel_panel_certs` volumes。只保留 project 名稱不足以遷移資料；直接啟動新版會建立空 DB。先記錄舊容器的實際 mounts 與 volume 名稱，並保留舊版完整設定及密鑰。

建議採邏輯備份：在仍使用舊 Compose 的來源目錄停止前端、API／worker，保持舊 DB 運行，以舊版 `panel.sh export /absolute/path/panel.dump` 匯出；隨後以舊設定 `down`（不可加 `-v`），再安裝新版、還原原 `.env`／`secrets/`、複製憑證及設定，最後執行新版 `import`，成功後才 `up`。若舊 API 另有可寫檔案掛載，也需一併離線備份。

舊服務全部停止後，以下範例在新版部署目錄將舊憑證 volume 唯讀掛載並複製；先用 `docker volume inspect` 確認 volume 確實存在，以免拼錯名稱而掛到新空 volume。目的 `certs/` 必須為空，不覆蓋已有私鑰：

```bash
docker volume inspect incudal-panel_panel_certs
mkdir -m 700 certs
docker run --rm --network none --entrypoint sh \
  --mount type=volume,src=incudal-panel_panel_certs,dst=/from,readonly \
  --mount "type=bind,src=$PWD/certs,dst=/to" \
  postgres:16-bookworm -eu -c \
  'test -z "$(ls -A /to)"; cp -a /from/. /to/; chown -R 1000:1000 /to; find /to -type d -exec chmod 700 {} +; find /to -type f -exec chmod 600 {} +'
```

若選擇實體複製 PostgreSQL 資料，必須先正常停止舊 DB，使用 PostgreSQL 16 相容映像及空的 `./data/postgres/`，保留所有檔案的擁有者、權限與連結；可沿用上述唯讀來源複製方式，將來源改為實際舊 DB volume、目的改為 `data/postgres/`，但**不要執行憑證用的 UID 1000／chmod 指令**。完整複製後必須保留與該 DB 相符的原 `postgres_password`。不可複製仍運行中的 PGDATA、混用兩套資料目錄或直接跨 PostgreSQL 大版本。實體複製與邏輯匯入擇一；保留舊 volumes 與獨立備份，直到新版完成資料、登入、解密與 Incus 連線驗收後，再由操作人員決定是否清理。

## PostgreSQL 匯出

DB 必須已啟動。不帶路徑時自動建立 `./backups/` 並產生 `panel-<UTC>-<隨機值>.dump`；亦可指定尚不存在的絕對路徑，其父目錄須事先存在：

```bash
bash panel.sh export
bash panel.sh export /srv/private-backups/panel-2026-11-07.dump
```

使用 PostgreSQL 16 容器內的 `pg_dump --format=custom --no-owner --no-acl` 取得一致性快照，可在面板運行中匯出。密碼在容器內從 secret 讀入 `PGPASSWORD`，不放在 CLI 引數、主機環境檔或輸出中。二進位串流直接寫入同目錄私有暫存檔，只有成功且非空才以 hard link 原子建立目的檔，不覆蓋既有檔案；失敗或中斷會清除暫存。目的檔案系統必須支援 hard link。備份包含敏感資料但**沒有加密**，須另行加密、離機保存並設定保留政策；不要存放於公開下載目錄。

## PostgreSQL 匯入

只接受可信的 PostgreSQL custom／tar archive，不接受純 SQL。PostgreSQL archive 能包含可執行的資料庫物件，`pg_restore --list` 僅確認可讀格式，不是惡意內容檢測。還原工具以資料庫擁有者連線，禁止匯入不可信來源。

```bash
bash panel.sh import /srv/private-backups/panel-2026-11-07.dump --confirm-replace-incudal
```

操作流程：

1. 在 `./backups/` 的私有暫存目錄複製來源，檢查五個 secret 與 Compose 設定。
2. 停止使用者前端、管理端與 API，避免背景 worker 持續寫入。只以 `up ... db` 啟動 DB 及相依的 `init`，等待 DB 健康；不啟動 API／migration，再讀取 archive 清單確認格式。格式錯誤也維持停機。
3. 將當前資料庫匯出至 `./backups/before-import-<UTC>-<隨機值>.dump`。備份失敗則拒絕匯入。
4. 使用 `pg_restore --clean --if-exists --single-transaction --exit-on-error --no-owner --no-acl` 還原至固定的 `incudal` 資料庫；發生 SQL 錯誤時回滾該交易。
5. 無論成功或失敗，面板均維持停止，避免自動執行 migration 或排程。確認程式版本、密鑰與憑證後，手動執行 `up`。

目標必須是相容的同一套面板 schema 或空資料庫；`--clean` 只清理 archive 中對應的物件，並不保證刪除目標額外物件。不同 schema／跨版本降級可能因依賴衝突而失敗，此時面板保持停止。不要將這個命令視為任意資料庫的清空或跨大版本遷移工具。只支援此 Compose 管理的 PostgreSQL 16；不修改外部資料庫、不建立或覆蓋角色與 tablespace。

CLI 停止的範圍僅限本 Compose 面板；操作人員須另外停止外部寫入程式／既有 systemd 後端。還原需要容納來源副本、還原前備份、DB 資料與交易 WAL 的磁碟空間。中斷後先確認 Docker 內的還原程序已結束，再啟動或重試；主機端腳本中斷不能保證立即取消容器內程序。

## 密鑰、憑證與更新限制

- DB archive 不含 `.env`、`secrets/`、`certs/`、`config/`、Incus 實例資料、ZFS、RFW 或任何外部儲存檔案。請另外安全備份配置、密鑰及憑證，並離機保存。
- **必須保存原 `secrets/encryption_key` 的值**（舊 systemd 部署為 `ENCRYPTION_KEY`）：程式以其原字串雜湊成 AES 金鑰，重新產生、改字元或多加空白都無法解密舊 DB 的加密資料。DB dump 無法補回遺失的金鑰。移機時不要因重新 `init` 而使用新金鑰；應在 API 第一次啟動前放回原值，勿將舊 env 檔整行 `ENCRYPTION_KEY=...` 或引號當作 secret 內容。
- 同時保存原 `jwt_secret`、`cookie_secret`、`admin_password` 與 `.env`。JWT／cookie 密鑰變動會使既有登入失效；`admin_password` 僅供初始建立使用，匯入既有管理員後不會重設其 DB 密碼。保留五個原 secret 是標準移機方式，CLI 不會替匯入資料重加密或重設管理員。
- 面板對 Incus 使用的 `client.crt`／`client.key` 位於宿主 `./certs/`，掛入容器 `/opt/incudal/server/certs`。既有部署搬遷須保留原憑證及私鑰並確保 UID 1000 可讀；新憑證須依既有流程重新建立 Incus 信任，DB 還原不會自動恢復該信任。
- PostgreSQL 密碼採 hex 以安全組合連線 URL；既有 PGDATA／實體 volume 搬遷必須保留相符的原 `postgres_password`，修改 secret 不會更新角色密碼。若僅將邏輯 dump 匯入全新 DB，可使用新 `init` 產生的 DB 密碼，因 dump 不含角色密碼；這不影響仍須保留原 `encryption_key` 的要求。
- Compose 固定向 API 注入 `INCUDAL_CONTAINER_DEPLOYMENT: 'true'`，禁止容器呼叫宿主 systemd／sudo OTA 更新或回滾；不要移除或覆寫此旗標。`GET /api/admin/system-update/version` 保留版本查詢，`GET /api/admin/system-update/check` 保留目前版本與 release 資訊，但回傳 `repositoryAvailable: false` 及 `repositoryError` 說明容器不可 OTA 與備份後重建方式，管理權限欄位仍按既有規則判定。
- 通過既有管理權限檢查後，`POST /api/admin/system-update/start` 與 `POST /api/admin/system-update/tasks/:id/rollback` 會回傳 HTTP 409、`CONTAINER_OTA_UNSUPPORTED`，在建立／修改任務、建立日誌目錄或啟動 worker 之前拒絕。更新請選定原始碼版本、先備份，再執行 `bash deploy/compose/panel.sh up` 重建；不提供自動 migration 回滾。
- Docker 建置使用專屬 allowlist ignore，排除本地依賴、環境檔、憑證及備份；runtime 保留 Prisma CLI 與建置依賴以沿用現有 workspace，尚未進行映像精簡與供應鏈掃描。基底映像固定主要版本標籤但未鎖 digest。
- Docker 管理員及主機 root 能讀取 Compose file secrets 與容器環境；這些檔案不是外部 secrets manager。勿上傳 secrets、備份或展開後的含密鑰環境。

## CI 與實機驗收

GitHub CI 執行版本核對、面板型別檢查與守衛、前後端建置、Agent 測試與跨架構建置，以及 Compose 映像建置；結果以對應 commit 的 Actions 紀錄為準。CI 建置成功不代表目標環境已完成部署驗收。安裝、權限初始化、容器啟動、首次還原、實際匯出／匯入及舊 volume 遷移須在隔離 Linux 環境驗證，TLS、登入、付款回呼與 Incus 連線另按目標主機設定驗收。
