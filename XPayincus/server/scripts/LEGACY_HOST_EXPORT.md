# 舊無 Docker 宿主面板匯出與 Compose 首次匯入

`export-legacy-host.mjs` 是獨立 Linux 工具，只依賴 Node.js 20 以上、相容的 `pg_dump`／`pg_restore`，選用封裝另需 GNU tar。使用 Node 內建模組，不必安裝專案依賴，也不載入舊面板程式碼。可用於統一版 v1.0.0 之前的舊部署；版本號不代表 schema 相容性。

預設讀取 `/opt/incudal/.env`，偵測 `current`（固定解析當下的 release）；沒有 `current` 時使用平鋪 `/opt/incudal`。不執行 source、eval、Prisma、SQL 寫入、systemctl、Docker、OTA 或套件安裝，不停止或重新啟動生產服務，不修改來源權限。讀取可能更新來源檔案系統 atime；資料庫備份會產生讀取負載及短暫鎖定。

## 執行匯出

在可信 Linux 宿主使用能讀取 `.env`、私鑰的帳號，並先準備由該帳號擁有的 0700 私有父目錄。以下命令由操作人員執行，工具不會自行建立父目錄或提權：

```bash
sudo install -d -m 700 /srv/private-panel-exports
sudo node /srv/release/XPayincus/server/scripts/export-legacy-host.mjs \
  --output /srv/private-panel-exports/legacy-before-compose --archive
```

目的路徑必須不存在，包含既有空目錄與符號連結也拒絕；不得位於原安裝或 active release 樹內。工具以獨佔 mkdir 保留目的地，目錄 0700、檔案 0600。請勿使用 shell trace、終端錄製或將私有輸出放在網站目錄。工具只印固定結果及警告數，不印 URL、密碼、密鑰、設定內容或外部工具日誌。

可指定不同安裝目錄及經核對的私有 env 副本：

```bash
sudo node /srv/release/XPayincus/server/scripts/export-legacy-host.mjs \
  --root /opt/incudal \
  --env-file /srv/private-panel-exports/confirmed.env \
  --output /srv/private-panel-exports/legacy-second-export
```

env 只按資料解析，支援空行、註解、單行 `KEY=value`、`export KEY=value`、單／雙引號及尾隨註解。拒絕重複欄位、多行、插值、命令替換、歧義引號及跳脫，不執行任何內容。未加引號值中的 `#` 只有前置空白時作為註解。若舊服務使用 systemd override、額外 EnvironmentFile、程序管理器或 shell 展開，須先人工核對實際生效值，建立 0600 的無歧義副本；工具不查 `/proc`，也不假定 env 就等於執行中程序設定。

`DATABASE_URL` 必須含 PostgreSQL host、資料庫、使用者，特殊字元按 URL percent encoding。密碼透過短暫 0600 `.pgpass` 傳遞，成功或失敗後移除，不放命令列；無密碼 URL 只適用於已配置的非互動認證，不會 sudo 切換 postgres 帳號。清除繼承的 PG 連線環境，拒絕未知／重複 URL 參數；支援 `sslmode`、絕對路徑 `sslrootcert`／`sslcert`／`sslkey`、`connect_timeout`，忽略 Prisma 專用 `schema`、`connection_limit`、`pool_timeout`、`pgbouncer`、`statement_cache_size`。SSL 檔案僅供來源連線使用，額外外部 TLS 檔案須另外安全備份。`pg_dump` 版本不得低於來源 PostgreSQL 大版本；目標目前為 PostgreSQL 16，來源高於 16 不可直接視為可還原。

缺少 `ENCRYPTION_KEY` 時工具拒絕猜測。更舊版本可能有 JWT fallback 或其他加密邏輯，須按實際運行版本確認：只有確認 DB 使用的原字串後，才將其以無換行的 0600 檔案提供給 `--encryption-key-file /private/effective-key`。此選項明確覆蓋 env 的加密值，不會自動使用 JWT_SECRET，不會產生新金鑰。不可把整行 `ENCRYPTION_KEY=...`、引號、base64 解碼值或 SHA-256 雜湊結果當作原字串。

## 輸出與一致性

| 輸出 | 用途 |
| --- | --- |
| `database.dump` | `pg_dump --format=custom --no-owner --no-acl` 的全資料庫一致性快照；含 migration 紀錄，不含角色密碼與全域角色 |
| `source/legacy.env` | 原 env 完整私有副本，含資料庫連線與其他整合設定 |
| `source/stable-*`、`source/active-*` | 原安裝與 active release 下存在的 `server/certs`、`certs`、`config` 副本，保留供人工核對 |
| `secrets/encryption_key` | 經解析的原加密字串，必須保留 |
| 其他 `secrets/*` | env 中存在的 JWT、cookie、初始管理員密碼，沒有值時記錄警告 |
| `certs/client.crt`、`certs/client.key` | 優先採明確 PANEL 路徑，再採穩定與 active 憑證路徑；相對明確路徑依應用根解析 |
| `manifest.json` | 來源路徑、部署結構、時間、警告、每個檔案 SHA-256 與大小；清單本身也是私有資料 |
| `private-tool.log` | 外部工具完整診斷與 archive catalog，可能含敏感資料，不可公開 |
| `COMPLETE` | 已完成資料備份與來源變動檢查的標記；必須同時確認沒有 `INCOMPLETE` |
| `migration.tar.gz` 與 `.sha256` | `--archive` 選用封裝；含 DB、設定、密鑰、憑證、manifest、COMPLETE，不含診斷日誌 |

`pg_restore --list` 只確認 archive 可讀，不代表還原成功或跨版本相容。資料庫快照與設定／憑證副本不是跨資源原子快照；工具會重新比對已複製檔案、目錄成員與 current，偵測到變更即失敗，但無法排除修改後還原等競態。匯出時避免 OTA、憑證輪替與設定修改；備份不涵蓋 Incus 實例磁碟、ZFS、RFW、宿主網路、Redis、外部物件儲存、任意 upload 目錄或 DB 自訂外部憑證路徑。設定／憑證目錄根可解析 symlink，內部連結與特殊檔案拒絕複製，須人工確認額外來源。

封裝只有壓縮，**沒有加密**。成功後須按既有私密資料流程加密、離機保存與限制存取。SHA-256 用於檢查損壞，不提供來源認證。失敗、磁碟滿或中斷會保留 `INCOMPLETE` 與私有部分輸出供排查；不得使用此目錄匯入，修正後改用新目的路徑。強制 SIGKILL／斷電可能留下 `.pgpass`，仍受私有目錄權限保護，操作人員須安全處理殘留。

## Compose 首次匯入

這是人工操作指南，匯出工具不執行下列部署或停機動作。先在隔離環境完成實際還原與相容性演練，再安排正式切換。歷史面板 v1.5.x 與統一版 v1.0.x 版本序列不同，不能按數字推定升降版或改寫 migration 紀錄。

1. 檢查來源 PostgreSQL／schema／Prisma migration 歷史與目標程式相容性，保存原程式版本、服務設定、DB 與金鑰作回復用。`manifest.json` 不含完整舊程式，須另行保留。線上匯出適合備份／演練，來源繼續寫入後舊 dump 不再是正式切換終點。
2. 在新主機準備完整倉庫或 Compose 來源發布包；按 [Compose 操作文件](../../deploy/compose/README.md) 的前置條件安裝至全新空目錄。不要覆蓋 `/opt/incudal`。以下命令在新部署目錄執行：

```bash
bash /srv/release/XPayincus/deploy/compose/panel.sh install /srv/incudal-panel
cd /srv/incudal-panel
bash panel.sh init https://pay.example.org https://admin.example.org admin@example.org
```

3. **不要先執行 `up`。** `init` 不啟動 DB 或 API。在可信環境透過安全檔案操作，將匯出 `secrets/encryption_key` 原樣取代新部署對應檔案，並保留原 `jwt_secret`／`cookie_secret`／`admin_password`（若有）。新 `postgres_password` 保留 init 產生的 hex 值，因這是新 DB 的邏輯匯入。此處對新產生 secret 的取代屬操作人員明確的遷移步驟；匯出工具本身一律拒覆寫。缺失欄位須核對舊版 fallback 與登入影響，不可直接假定新值可用。
4. 將有效 Incus 憑證及私鑰放入新部署 `certs/`，對照 DB 的每台主機憑證路徑與信任。`source/*` 留作參考，勿將多套憑證扁平混合覆蓋。`config/` 中僅遷移經確認兼容的執行設定，並核對容器內路徑。憑證目錄 0700、檔案 0600，API 的 UID 1000 必須可讀。來源 `.env` 僅供核對，**不可整份覆蓋 Compose `.env`**；來源 URL、付款、郵件、Agent 來源等設定須按 Compose 明確注入欄位逐一確認，任意舊 env 不會自動注入 API。
5. 演練使用隔離網路，避免新 API 執行真實付款／交付排程或連上生產宿主。正式切換時由操作人員停止舊面板 API、worker 與所有其他寫入端，保持來源 PostgreSQL 啟動，使用工具匯出到另一個全新目錄。工具永遠不會停止舊服務。確保從最終匯出至切換完成，舊寫入端保持停止。
6. 安全傳送最終輸出；若有封裝，在私有空目錄驗證 SHA-256 並解包可信 archive。不要解包不可信 tar 或匯入不可信 PostgreSQL archive。確認存在 `COMPLETE`、沒有 `INCOMPLETE`，核對 manifest 檔案雜湊及警告；重新還原最終設定／原密鑰／憑證後，執行：

```bash
cd /srv/incudal-panel
bash panel.sh import /srv/private-panel-exports/final/database.dump --confirm-replace-incudal
```

7. `import` 只啟動新 Compose DB 與相依 init 服務，先備份目標 DB，再單一交易還原，結束後面板保持停止，不執行 migration。首次 before-import 備份可能只有空 DB。失敗時不要啟動 API，先診斷相容性及權限，勿刪 `_prisma_migrations` 或使用 `db push --accept-data-loss`。
8. 確認舊 API／worker 全數停止、資料／原密鑰相符、宿主端點可由容器路由後，才執行 `bash panel.sh up`。這一步會執行 Prisma migration 並啟動單一 API；不得同時重開舊 systemd 後端。完成雙 HTTPS origin、登入、資料筆數、歷史加密設定解密、Incus 信任／連線、付款回呼及排程驗收後，再切換對外流量。

目標有新寫入或執行 migration 後，回退須重新評估資料一致性，不可直接重啟舊服務接舊 DB 而丟棄新交易。匯出工具不提供自動切換、回滾或刪除備份。

## 發布包與驗證邊界

工具與本文件放在 `XPayincus/server/scripts/`，自統一版 v1.0.2 納入 Dashboard Compose 來源包及原生 Panel 包。Dashboard 透過 `git archive HEAD` 收錄完整 `XPayincus/server/`，根 `package-dashboard-release.sh` 與 `prepare-compose-release.mjs` 也會核對這兩個檔案。當前未提交檔案不會進入 `HEAD` 發布包，本次不執行 commit 或發布。Compose 安裝後的 `source/server/scripts/` 也可找到此工具。

原生 `xpayincus-panel-v1.0.2-linux-{amd64,arm64}.tar.gz` 的根 `build-server-release.sh` 明確將工具與本指南複製至包內 `server/scripts/`，不包含其他測試／開發腳本。原生包解壓根沒有外層 `XPayincus/`，執行路徑例如 `sudo node /srv/panel-release/server/scripts/export-legacy-host.mjs --output /srv/private-panel-exports/native-export --archive`。工具單檔可獨立執行，不會隨封裝、OTA 或 API 啟動自動執行；仍需本文件所列的 Linux／Node／PostgreSQL CLI 前置條件。

本次依要求不做本機測試；交付前僅靜態檢閱。正式使用前須由維運在隔離 Linux 環境完成平鋪／current 舊布局、含特殊字元 URL、缺失金鑰、拒覆寫、中斷、憑證自訂路徑與首次還原的實際演練，並驗證原金鑰能解密既有資料。
