# 面板 Docker Compose 部署與 PostgreSQL 匯出匯入

本配置僅部署 Dashboard／面板：使用者前端、管理端前端、單一 API 程序及 PostgreSQL 16。Agent、Incus、ZFS、RFW 與宿主機網路服務維持既有宿主機部署，不提供容器、不掛載 Docker socket、不使用 privileged 或 host network。原 systemd／Nginx 配置保留；發行入口是統一倉庫根 `.github/workflows`，子目錄 workflow 僅作歷史參考。

## 前置條件

- Linux 主機，Bash、OpenSSL、util-linux `flock`、GNU coreutils、Docker Engine 與 Compose v2 外掛；Compose 必須支援 `up --wait --wait-timeout`，不支援舊版 `docker-compose` v1。操作帳號須能存取 Docker daemon 並讀寫部署目錄，初始化與後續操作請使用同一帳號。
- 完整面板原始碼與既有 pnpm lockfile；建置需存取容器 registry、Debian 套件來源、npm registry 與 Prisma engine 下載來源。建置階段使用 Node 22、pnpm 9.14.2，執行既有前後端 build；宿主機不必安裝 Node、pnpm 或 PostgreSQL。
- 兩個不同的 HTTPS origin、DNS、TLS 憑證，以及同一台主機上的可信反向代理。預設使用 `127.0.0.1:8080`／`127.0.0.1:8081` 作為反向代理 upstream。
- 僅部署一套 `incudal-panel`。API 固定容器名稱，禁止 `--scale api=2`、額外 Compose project 或與舊 systemd 後端同時連線至同一 DB。API 的程序內狀態要求單實例。

Windows 工作區可編輯這些檔案；部署 CLI 應在 Linux 主機或具有 Docker 存取權的 WSL Linux 檔案系統執行，並使用 LF 換行。不要透過 PowerShell 5 的文字重導向處理二進位備份。

### 原始碼與必要檔案

可使用完整倉庫，或解壓 Dashboard Compose 原始碼包 `xpayincus-dashboard-<版本>-compose.tar.gz`。包內須保留 `XPayincus/` 的相對目錄；**只複製 `deploy/compose/` 無法建置**。`compose.yaml` 的 `context: ../..` 解析為 `XPayincus/`，不是統一倉庫根目錄。這是原始碼建置部署，並非下載預先發布的面板映像。

根打包腳本 `scripts/package-dashboard-release.sh` 會透過 `prepare-compose-release.mjs` 在包內產生 `deploy/compose/compose.release.yaml`，為 `api`、`user`、`admin` 指定版本映像名稱與 `org.opencontainers.image.version` 建置標籤。此 override 保留原有 build 設定，`panel.sh up` 仍從包內原始碼建置映像。

`panel.sh` 會先載入 `compose.yaml`，若同目錄存在 `compose.release.yaml`，再將其作為第二個 Compose 檔載入；檔案必須可讀且非空，否則停止操作。`up` 的設定解析、建置、停止與啟動，以及 `down`、`status`、`logs`、`export`、`import` 均共用這組設定，無須手動傳入 override。沒有此檔時沿用原始碼倉庫的基本配置；`init` 與 help 不呼叫 Compose。

| 路徑（相對於 `XPayincus/`） | 用途 |
| --- | --- |
| `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` | 固定 workspace 與依賴版本，使用 frozen lockfile 安裝 |
| 完整 `client/` | 包含 package、Vite／TypeScript 設定、`index.html`、`src/`、`public/`，建置兩套獨立前端 |
| 完整 `server/` | 包含 package、TypeScript 設定、`src/`、Prisma config、schema 及完整 migration 歷史 |
| `server/templates/install.sh`、`agent-install.sh`、`caddy.sh` | API 提供的宿主安裝模板；仍由宿主執行，保留在 `server/templates/`，不靠 TypeScript 複製 |
| `deploy/compose/Dockerfile`、`Dockerfile.dockerignore` | 多階段建置及專屬 build context 排除規則，兩檔皆須保留 |
| `deploy/compose/api-entrypoint.sh`、`nginx.conf.template` | API secret／migration／單程序啟動及雙前端 Nginx 路由 |
| `deploy/compose/compose.yaml`、`panel.sh`、`https-proxy.conf.example` | 服務定義、部署 CLI 與宿主 HTTPS 代理範例 |

API 映像保留根 `node_modules` 的 pnpm store、`server/node_modules` 連結、已產生的 Prisma client 與 Prisma CLI；不要只複製 `server/dist/`。建置用的 `DATABASE_URL` 為無實際資料庫的佔位 URL，供 Prisma generate 載入設定；建置不執行 migration、不需要正式 DB 密碼。

## 首次部署

1. 在 Linux 安裝 Docker Engine 與 Compose v2 外掛。Debian／Ubuntu 的其他前置工具可用 `sudo apt-get install bash openssl util-linux coreutils` 安裝。另為宿主 HTTPS 代理準備 Nginx、DNS 與兩組有效憑證。規劃建置、DB、WAL 及備份空間。
2. 進入倉庫或原始碼包的 `XPayincus/` 目錄，確認 `docker version`、`docker compose version` 可用，再將示例網域替換為自己的網域執行初始化：

```bash
cd /srv/longshang-xpayincus/XPayincus
bash deploy/compose/panel.sh init https://pay.example.org https://admin.example.org admin@example.org
```

`init` 不連線資料庫、不建立容器。它以 `umask 077` 建立 `.env`、私有 `secrets/` 目錄及各自獨立的 PostgreSQL、JWT、cookie、加密與管理員密碼，拒絕覆蓋既有配置。初始帳號為 `admin`；密碼位於 `deploy/compose/secrets/admin_password`，不會印到終端。請在可信環境以安全方式讀取並保存。若初始化中斷，先檢查已建立的配置，勿任意重新產生或替換既有密鑰。

3. 如需改用其他 loopback 埠，啟動前編輯 `deploy/compose/.env` 的 `USER_PORT`／`ADMIN_PORT`，並同步修改宿主代理 upstream。不要先複製 `.env.example`，否則 `init` 會拒絕覆蓋；該檔僅為欄位參考。
4. 依下一節設定宿主 HTTPS 代理，然後啟動面板：

```bash
bash deploy/compose/panel.sh up
bash deploy/compose/panel.sh status
```

`up` 先檢查必要原始碼、部署檔及五個 secret 檔是否可讀且非空，再以 `docker compose config --quiet` 解析設定；檢查不輸出展開後的配置。接著建置映像，建置成功才停止既有面板與 API，再依序啟動 DB、API、雙前端；API 先執行 `prisma migrate deploy`，成功後以非 root 的單一 Node 程序啟動。Dockerfile 會檢查雙前端首頁、後端入口及三份宿主模板均已存在。

Compose 啟動等待最長 300 秒，包含 DB／API 健康檢查及兩套 Nginx 的 `/index.html` HTTP 檢查；這不代表已完成 TLS、登入或瀏覽器端驗收。Migration 失敗時前端不會重新開放；修正原因後再執行 `up`。Migration 可能修改資料，升級前請先匯出備份。超時或 unhealthy 不會自動回滾或停止整套服務，先查看 `status` 與 `logs api`，勿直接重建 DB volume。

### HTTPS 與容器網路

Compose 的 DB 與 API 不發布宿主機埠；DB 使用 internal network，API 另有對外網路以連線既有宿主機及第三方服務。只有雙前端 HTTP 埠發布至 loopback。Docker 網路及防火牆必須允許 API 到既有 Incus／Agent 相關端點，宿主機端點不可填容器內的 `127.0.0.1`。

將 [https-proxy.conf.example](./https-proxy.conf.example) 的網域與憑證路徑替換後，整合至宿主機 Nginx。該檔案放在 Nginx `http` context；TLS 憑證簽發、續期、80→443 轉址及正式網域限制由宿主機管理。管理端可再加 VPN 或來源 IP 限制。必須由這層代理**覆寫** `X-Real-IP`，容器 Nginx 僅轉送該可信值，避免客戶端偽造付款白名單或限流所使用的 IP。若前方還有 CDN，先在宿主機按 CDN 官方網段設定 real-IP 信任範圍，不能直接信任任意來源 header。

Nginx 範例的 upstream 為 HTTP，不能改成容器的 HTTPS 埠；若公開 origin 使用非預設埠，也須同步調整宿主 `listen`。在部署主機完成設定後執行 `sudo nginx -t`，確認成功再執行 `sudo systemctl reload nginx`。這兩個命令由操作人員在目標主機執行，CLI 不修改宿主代理。

本配置固定 HTTPS cookies、host-only cookies 與同源 `/api`，包含 WebSocket upgrade；不要直接透過 HTTP localhost 登入。若更改 `.env` 中的公開 URL，執行 `up` 重建前端，因跨面板連結是建置時注入。

### 設定欄位與日常操作

| `.env` 欄位 | 說明 |
| --- | --- |
| `FRONTEND_URL`、`ADMIN_FRONTEND_URL` | 不同的 HTTPS origin，無路徑或尾斜線；用於 CORS、公開 URL 及建置時跨面板連結 |
| `ADMIN_EMAIL` | 首次建立 `admin` 的電子郵件；改值不會覆蓋既有管理員資料 |
| `USER_PORT`、`ADMIN_PORT` | 不同且未占用的宿主 loopback TCP 埠，預設 8080／8081 |
| `INCUDAL_RELEASE_REPOSITORY`、`INCUDAL_AGENT_RELEASE_REPOSITORY` | 可選的 Agent 資產來源 `owner/repo`；依既有 Agent 來源解析規則使用，不啟用面板 OTA |

`.env` 只供 Compose 插值，不會整份注入 API。額外 API 變數須明確加入部署設定；密碼與金鑰仍放 `secrets/`。避免在執行 shell 預先匯出同名變數，因 shell 的值優先於 `--env-file`。API 的 root entrypoint 只負責載入 secret、設定憑證目錄權限，再交由 UID 1000 執行 migration 與 Node；不要直接改成 `user: node`，否則無法讀取私有 file secrets 或修正 volume 權限。

```bash
bash deploy/compose/panel.sh status
bash deploy/compose/panel.sh logs
bash deploy/compose/panel.sh logs api
bash deploy/compose/panel.sh down
```

`status` 包含已退出的容器，`logs` 顯示全部或指定服務最近 100 行且不持續追蹤。分享日誌前先移除敏感資料。`down` 保留 DB 與面板憑證 volumes；不要使用 `docker compose down -v`，它會刪除資料。CLI 固定 project 名稱及 Compose 路徑，可從其他目錄使用腳本絕對路徑執行。所有 CLI 操作使用同一把非阻塞鎖；直接呼叫 Docker 或其他專案副本不受這把鎖保護。

如需直接使用 Compose 工具，在 `XPayincus/` 目錄明確帶入相同的 project、env 與 compose 路徑，並在存在 release override 時以相同順序加入，例如查看完整服務狀態：

```bash
compose_files=(--file deploy/compose/compose.yaml)
if [[ -f deploy/compose/compose.release.yaml ]]; then
  compose_files+=(--file deploy/compose/compose.release.yaml)
fi
docker compose --project-name incudal-panel \
  --env-file deploy/compose/.env "${compose_files[@]}" ps --all
```

### 部署驗收與排查

以下命令供操作人員在目標 Linux 主機部署後執行，本次文件整理未執行：

```bash
curl --fail --silent --show-error https://pay.example.org/api/health
curl --fail --silent --show-error https://admin.example.org/api/health
```

再以瀏覽器確認兩端頁面、管理員登入與 WebSocket 終端；檢查使用者端不載入管理端入口，並確認 API 可連到目標 Incus。付款回呼與來源 IP 白名單須按實際付款來源設定，不可為了通過驗收關閉白名單。

| 現象 | 排查方向 |
| --- | --- |
| `init` 拒絕覆蓋 | 檢查是否已有 `.env`／`secrets/`，既有部署保留原檔，不重新初始化 |
| build 缺檔或 lockfile 不符 | 使用完整原始碼及同版本 lockfile，保留 `Dockerfile.dockerignore`；檢查 registry／Prisma 下載連線 |
| API restart／migration 錯誤 | `panel.sh logs api`、`logs db`；確認 DB 密碼與既有 volume 相符及完整 migration 歷史，不跳過 migration |
| 健康檢查超時 | `status` 查看含退出容器的狀態；Nginx 看 `logs user`／`logs admin`，API 看 migration 及啟動訊息 |
| HTTPS 502／登入失敗 | 核對宿主 upstream 埠、DNS／憑證、兩個 origin 與 secure cookie，確認已重建前端 |
| Incus 連線或憑證失敗 | 檢查容器到宿主的可路由位址、防火牆、憑證 volume 與 UID 1000 讀取權限 |

不要用 `prisma db push --accept-data-loss`、刪除 migration 紀錄或清除 volume 來繞過啟動錯誤。若已有 DB migration 失敗，須先備份並診斷該 migration，再按 Prisma 的既有資料庫修復流程處理。

## 更新與移機

更新前記錄目前來源版本，安全保存 `.env`、整個 `secrets/`、憑證 volume，並執行下一節的 DB 匯出。準備目標版本的完整原始碼後，把原配置放回相同的 `deploy/compose/` 相對位置，再執行 `panel.sh up`。維持 project 名稱 `incudal-panel`，才能沿用 `incudal-panel_postgres_data` 與 `incudal-panel_panel_certs` volumes。建置期間舊 API 仍運作，建置成功後才進入停機更新。

使用發行包更新時保留目標包附帶的 `compose.release.yaml`，不要從舊版本複製該檔，避免將新原始碼標成舊版映像。它不含私人設定，不需由 `init` 產生。

移機時先在新主機準備完整原始碼、原配置與憑證，停止舊主機所有 API／worker，再於新主機只啟動 DB，匯入可信備份；不要先啟動 API 對待還原資料庫執行 migration：

```bash
compose_files=(--file deploy/compose/compose.yaml)
if [[ -f deploy/compose/compose.release.yaml ]]; then
  compose_files+=(--file deploy/compose/compose.release.yaml)
fi
docker compose --project-name incudal-panel \
  --env-file deploy/compose/.env "${compose_files[@]}" \
  up -d --wait --wait-timeout 300 db
bash deploy/compose/panel.sh import /srv/private-backups/panel.dump --confirm-replace-incudal
bash deploy/compose/panel.sh up
```

此時自動產生的 before-import 備份可能僅含空 DB。新主機須事先以安全離線流程還原憑證 volume，確認 UID 1000 可讀取憑證及私鑰，再啟動 API。完成 HTTPS 與功能驗收後切換對外流量；全程只能有一個 API 執行背景任務。程式降版不會回復 schema，須搭配相容的 DB 備份及原金鑰，不提供自動回滾。

## PostgreSQL 匯出

DB 必須已啟動；使用尚不存在的絕對路徑，父目錄必須事先存在：

```bash
bash deploy/compose/panel.sh export /srv/private-backups/panel-2026-11-06.dump
```

使用 PostgreSQL 16 容器內的 `pg_dump --format=custom --no-owner --no-acl` 取得一致性快照，可在面板運行中匯出。密碼在容器內從 secret 讀入 `PGPASSWORD`，不放在 CLI 引數、主機環境檔或輸出中。二進位串流直接寫入同目錄私有暫存檔，只有成功且非空才以 hard link 原子建立目的檔，不覆蓋既有檔案；失敗或中斷會清除暫存。目的檔案系統必須支援 hard link。備份包含敏感資料但**沒有加密**，須另行加密、離機保存並設定保留政策；不要存放於公開下載目錄。

## PostgreSQL 匯入

只接受可信的 PostgreSQL custom／tar archive，不接受純 SQL。PostgreSQL archive 能包含可執行的資料庫物件，`pg_restore --list` 僅確認可讀格式，不是惡意內容檢測。還原工具以資料庫擁有者連線，禁止匯入不可信來源。

```bash
bash deploy/compose/panel.sh import /srv/private-backups/panel-2026-11-06.dump --confirm-replace-incudal
```

操作流程：

1. 在私有暫存目錄複製來源並讀取 archive 清單，先確認格式。
2. 停止使用者前端、管理端與 API，避免背景 worker 持續寫入。
3. 將當前資料庫匯出至 `deploy/compose/backups/before-import-<UTC>-<隨機值>.dump`。備份失敗則拒絕匯入。
4. 使用 `pg_restore --clean --if-exists --single-transaction --exit-on-error --no-owner --no-acl` 還原至固定的 `incudal` 資料庫；發生 SQL 錯誤時回滾該交易。
5. 無論成功或失敗，面板均維持停止，避免自動執行 migration 或排程。確認程式版本、密鑰與憑證後，手動執行 `up`。

目標必須是相容的同一套面板 schema 或空資料庫；`--clean` 只清理 archive 中對應的物件，並不保證刪除目標額外物件。不同 schema／跨版本降級可能因依賴衝突而失敗，此時面板保持停止。不要將這個命令視為任意資料庫的清空或跨大版本遷移工具。只支援此 Compose 管理的 PostgreSQL 16；不修改外部資料庫、不建立或覆蓋角色與 tablespace。

CLI 停止的範圍僅限本 Compose 面板；操作人員須另外停止外部寫入程式／既有 systemd 後端。還原需要容納來源副本、還原前備份、DB 資料與交易 WAL 的磁碟空間。中斷後先確認 Docker 內的還原程序已結束，再啟動或重試；主機端腳本中斷不能保證立即取消容器內程序。

## 密鑰、憑證與更新限制

- DB archive 不含 `secrets/`、`.env`、`panel_certs` volume、Incus 實例資料、ZFS、RFW 或任何外部儲存檔案。請另外安全備份配置及憑證。移機還原時必須保留原 `ENCRYPTION_KEY`，否則已加密的資料無法解密；JWT／cookie 密鑰變動會使既有登入失效。
- 面板對 Incus 使用的 `client.crt`／`client.key` 存放於 `/opt/incudal/server/certs` named volume。既有部署搬遷須以安全離線流程保留原憑證，並確保 Node UID 1000 能讀取；新憑證須依既有流程建立信任。
- PostgreSQL 密碼採 hex 以安全組合連線 URL；請勿隨意更換其 secret。既有 PostgreSQL volume 不會因修改 `POSTGRES_PASSWORD_FILE` 而更新角色密碼。
- Compose 固定向 API 注入 `INCUDAL_CONTAINER_DEPLOYMENT: 'true'`，禁止容器呼叫宿主 systemd／sudo OTA 更新或回滾；不要移除或覆寫此旗標。`GET /api/admin/system-update/version` 保留版本查詢，`GET /api/admin/system-update/check` 保留目前版本與 release 資訊，但回傳 `repositoryAvailable: false` 及 `repositoryError` 說明容器不可 OTA 與備份後重建方式，管理權限欄位仍按既有規則判定。
- 通過既有管理權限檢查後，`POST /api/admin/system-update/start` 與 `POST /api/admin/system-update/tasks/:id/rollback` 會回傳 HTTP 409、`CONTAINER_OTA_UNSUPPORTED`，在建立／修改任務、建立日誌目錄或啟動 worker 之前拒絕。更新請選定原始碼版本、先備份，再執行 `bash deploy/compose/panel.sh up` 重建；不提供自動 migration 回滾。
- Docker 建置使用專屬 allowlist ignore，排除本地依賴、環境檔、憑證及備份；runtime 保留 Prisma CLI 與建置依賴以沿用現有 workspace，尚未進行映像精簡與供應鏈掃描。基底映像固定主要版本標籤但未鎖 digest。
- Docker 管理員及主機 root 能讀取 Compose file secrets 與容器環境；這些檔案不是外部 secrets manager。勿上傳 secrets、備份或展開後的含密鑰環境。

## 本次交付狀態

依使用者指示，本次不執行任何驗證測試；未執行 shell 語法檢查、Compose 配置解析、映像建置、容器啟動、type-check、守衛測試或實際匯出／匯入。這是待在隔離 Linux 環境驗收的實作，不代表生產可用性已有證據。
