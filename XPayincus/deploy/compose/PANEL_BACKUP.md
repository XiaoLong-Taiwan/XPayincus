# 管理面板加密備份

管理端「面板備份」建立最近 7 份加密封存。內容包括 PostgreSQL `incudal` **整個資料庫**的 custom dump、部署 `.env`、Compose 必要 secrets（PostgreSQL、JWT、cookie、encryption、admin password）及面板 `certs/` 中權限為 600 的一般檔案。資料庫快照包含面板內所有資料表與使用者／客戶資料，例如帳號、訂單、餘額及設定；不是只備份管理員或設定。資料庫內的物件 key／URL 會被備份，但 S3、FTP、SFTP、WebDAV 等外部儲存中的實際檔案不會複製。備份不包括 `data/postgres` 原始目錄、Incus VM／容器磁碟、宿主檔案、Agent、ZFS 或 RFW 資料，也不改變網路 probe 或系統更新流程。

建立前要求已登入管理員以帳號電子郵件完成一次性二次驗證，再輸入至少 16 字元 passphrase；後端另限制每小時最多兩次建立請求，且同一程序同時只執行一份。下載必須是已登入管理員，並使用綁定該管理員、60 秒有效、一次性 token。passphrase 不寫入檔案、應用日誌或工作狀態，完成後清除可變 buffer；Node.js／瀏覽器字串記憶體無法保證即時覆寫。封裝使用 scrypt（N=32768,r=8,p=1）派生 AES-256-GCM 金鑰，gzip 壓縮後串流加密。GCM tag 用於偵測封裝遭竄改；忘記 passphrase 即無法解密。

`pg_dump` 以串流輸出至備份目錄的 0600 custom dump 暫存檔，再由 tar/gzip/AES-GCM 管線串流封裝；不將 dump、tar 或壓縮內容整體載入記憶體。磁碟峰值仍需容納一份未加密 dump 加一份最終封裝，且須預留 PostgreSQL 暫存空間。整個 backups 目錄設為 0700；成功或失敗都會刪除 dump 暫存。發佈採同一檔案系統原子 rename，失敗不保留不完整備份。保留策略在成功建立後清理至最新 7 份。操作人員仍應定期將加密封裝複製到獨立離線儲存。

API 僅接觸已指定的 secrets file、唯讀 `.env` 單檔掛載、面板 certs 目錄及專用 backups 目錄；不掛 Docker socket、不讀 PostgreSQL volume、不讀宿主任意路徑。啟動時由 root 將 secrets 與 `.env` 複製至容器內 `/run/incudal-backup`，目錄 0700、檔案 0600 並交給 node；備份讀取此啟動快照，變更部署憑證後須重建 API 容器。原唯讀掛載不修改權限或擁有者。封裝內 `.env` 與 secrets 含有可重用憑證，雖有 passphrase 加密仍應視為高度敏感資料。API image 從 PGDG 安裝 `postgresql-client-16`，建置時檢查 `pg_dump` 主版本為 16，並使用 GNU tar。下載回應使用 `no-store`，伺服器封存檔以 0600 建立。

## 還原

目前 UI **只建立及下載備份，不提供解密、封裝驗證或資料庫還原功能**。復原時先在可信、離線且磁碟加密的 Linux 主機上依 XPB1 格式解密；必須先成功驗證 AES-GCM tag，驗證失敗即丟棄整份輸出，不可解壓／匯入。再檢查 tar 僅有預期的 `database.dump`、`.env`、`secrets/`、`certs/` 路徑，拒絕絕對路徑、`..`、連結與特殊檔案。確認內容後才將各檔安全還原至部署目錄；確認原 `encryption_key` 和其他 secrets／憑證已復原後，依 Compose 操作手冊使用 `bash panel.sh import /absolute/path/database.dump --confirm-replace-incudal`。匯入會覆寫面板資料庫並停止既有面板；必須先確認目標與相容版本，另留現況備份。還原需要額外空間容納解密後封裝、dump、DB 與 WAL。此 UI 不執行解密或資料庫還原。

此備份是面板資料與明確列出的部署憑證／設定，不是整機災難復原映像；Compose profile 的 TLS 憑證、Cloudflare Tunnel token 和宿主 Nginx 設定不包含在包內。TLS／Tunnel 憑證應依各自儲存位置另行保護備份。
