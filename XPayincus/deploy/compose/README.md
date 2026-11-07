# 面板 Docker Compose 部署與 PostgreSQL 匯出匯入

本配置僅部署 Dashboard／面板：使用者前端、管理端前端、單一 API 程序及 PostgreSQL 16。Agent、Incus、ZFS、RFW 與宿主機網路服務維持既有宿主機部署，不提供容器、不掛載 Docker socket、不使用 privileged 或 host network。原 systemd／Nginx 配置保留；發行入口是統一倉庫根 `.github/workflows`，子目錄 workflow 僅作歷史參考。

## 前置條件

- Linux 主機，Bash、OpenSSL、util-linux `flock`、GNU coreutils、Docker Engine 與支援 `up --wait` 的 Compose v2。
- 完整原始碼與既有 pnpm lockfile；建置需存取容器 registry 與 npm registry。建置階段使用 Node 22、pnpm 9.14.2，執行既有前後端 build。
- 兩個不同的 HTTPS origin、DNS、TLS 憑證，以及同一台主機上的可信反向代理。預設使用 `127.0.0.1:8080`／`127.0.0.1:8081` 作為反向代理 upstream。
- 僅部署一套 `incudal-panel`。API 固定容器名稱，禁止 `--scale api=2`、額外 Compose project 或與舊 systemd 後端同時連線至同一 DB。API 的程序內狀態要求單實例。

Windows 工作區可編輯這些檔案；部署 CLI 應在 Linux 主機或具有 Docker 存取權的 WSL Linux 檔案系統執行，並使用 LF 換行。不要透過 PowerShell 5 的文字重導向處理二進位備份。

## 首次部署

在統一倉庫的 `XPayincus/` 目錄執行以下命令，將示例網域替換為自己的網域：

```bash
bash deploy/compose/panel.sh init https://pay.example.org https://admin.example.org admin@example.org
bash deploy/compose/panel.sh up
```

`init` 不連線資料庫、不建立容器。它以 `umask 077` 建立 `.env`、私有 `secrets/` 目錄及各自獨立的 PostgreSQL、JWT、cookie、加密與管理員密碼，拒絕覆蓋既有配置。初始帳號為 `admin`；密碼位於 `deploy/compose/secrets/admin_password`，不會印到終端。請在可信環境以安全方式讀取並保存。若初始化中斷，先檢查已建立的配置，勿任意重新產生或替換既有密鑰。

`up` 建置映像、停止既有面板與 API，再依序啟動 DB、API、雙前端；API 先執行 `prisma migrate deploy`，成功後以非 root 的單一 Node 程序啟動。等待 DB／API 健康狀態，最長 300 秒；前端只有程序啟動狀態，這不代表已完成瀏覽器端驗收。Migration 失敗時前端不會重新開放；修正原因後再執行 `up`。Migration 可能修改資料，升級前請先匯出備份。

Compose 的 DB 與 API 不發布宿主機埠；DB 使用 internal network，API 另有對外網路以連線既有宿主機及第三方服務。只有雙前端 HTTP 埠發布至 loopback。Docker 網路及防火牆必須允許 API 到既有 Incus／Agent 相關端點，宿主機端點不可填容器內的 `127.0.0.1`。

將 [https-proxy.conf.example](./https-proxy.conf.example) 的網域與憑證路徑替換後，整合至宿主機 Nginx。該檔案放在 Nginx `http` context；TLS 憑證簽發、續期、80→443 轉址及正式網域限制由宿主機管理。管理端可再加 VPN 或來源 IP 限制。必須由這層代理**覆寫** `X-Real-IP`，容器 Nginx 僅轉送該可信值，避免客戶端偽造付款白名單或限流所使用的 IP。若前方還有 CDN，先在宿主機按 CDN 官方網段設定 real-IP 信任範圍，不能直接信任任意來源 header。

本配置固定 HTTPS cookies、host-only cookies 與同源 `/api`，包含 WebSocket upgrade；不要直接透過 HTTP localhost 登入。若更改 `.env` 中的公開 URL，執行 `up` 重建前端，因跨面板連結是建置時注入。

```bash
bash deploy/compose/panel.sh status
bash deploy/compose/panel.sh down
```

`down` 保留 DB 與面板憑證 volumes；不要使用 `docker compose down -v`，它會刪除資料。CLI 固定 project 名稱及 Compose 路徑，可從其他目錄使用腳本絕對路徑執行。所有 CLI 操作使用同一把非阻塞鎖；直接呼叫 Docker 或其他專案副本不受這把鎖保護。

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
- 不支援容器內 systemd／sudo OTA；面板中的舊線上更新功能不適用。更新請選定原始碼版本、先備份，再執行 `up` 重建；不提供自動 migration 回滾。
- Docker 建置使用專屬 allowlist ignore，排除本地依賴、環境檔、憑證及備份；runtime 保留 Prisma CLI 與建置依賴以沿用現有 workspace，尚未進行映像精簡與供應鏈掃描。基底映像固定主要版本標籤但未鎖 digest。
- Docker 管理員及主機 root 能讀取 Compose file secrets 與容器環境；這些檔案不是外部 secrets manager。勿上傳 secrets、備份或展開後的含密鑰環境。

## 本次交付狀態

依使用者指示，本次不執行任何驗證測試；未執行 shell 語法檢查、Compose 配置解析、映像建置、容器啟動、type-check、守衛測試或實際匯出／匯入。這是待在隔離 Linux 環境驗收的實作，不代表生產可用性已有證據。
