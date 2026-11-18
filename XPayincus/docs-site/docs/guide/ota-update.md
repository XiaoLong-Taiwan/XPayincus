---
title: 更新與原生 OTA
description: 區分 Compose 安全更新、診斷恢復與原生 systemd 原子 OTA
---

# 更新與原生 OTA

<p class="doc-lead">Compose 由宿主 CLI 核驗、備份並重建容器；原生 systemd 部署由管理後台執行原子 OTA。兩種部署都須另外確認資料庫相容性與還原計畫。</p>

## 更新前準備與發行來源

Dashboard 小型部署建議以 **2 vCPU、4 GiB RAM、40 GiB SSD** 作為起點，備份空間另計。這是未經壓力測試的建議，不是安裝硬門檻或容量保證；DB／WAL、日誌、下載解壓與來源建置的峰值須另外評估，宿主實例資源不包含在內。

先確認部署方式、目前與目標版本、完整 migration、可用磁碟及備份可還原性。維持單一 API／Node 程序，禁止新舊部署同時對同一 DB 執行 API／worker。歷史面板 v1.5.9 遷移至統一版 v1.0.x 必須走受控遷移，不可改寫版本或以 Git fallback 繞過降版守衛。

根 `VERSION` 是統一產品版本；根 `.github/workflows/release.yml` 在相符的 `v*` tag 推送並通過驗證、封裝與映像工作後建立 GitHub Release，手動觸發不建立 Release。Actions artifacts、Release 資產、registry 映像與實際部署驗收須分別確認，workflow 不自動部署。遠端原生 artifact OTA 需要所設定 Release 中實際存在面板 tarball、雜湊及 `ota-manifest.json`；包含多元件的 `release-manifest.json` 不能取代 OTA manifest。

原生 `scripts/install-panel.sh` 已使用統一倉庫 `XiaoLong-Taiwan/XPayincus`，並驗證 checksum 與 archive。根 `scripts/dashboard.sh --host-install` 只做最新正式版全新原生 Panel 安裝，需要 root 與互動確認，拒絕既有 `/opt/incudal`，不能當作既有部署更新指令。

## Compose 一般更新

Compose 不支援容器內 systemd／sudo OTA；後台啟動更新與回滾會回傳 `409 CONTAINER_OTA_UNSUPPORTED`。版本查詢仍保留，更新請在宿主 Linux 執行 CLI。以下短入口從統一倉庫根目錄執行；部署絕對路徑須由自己管理且信任，入口會執行該目錄既有的 `panel.sh`：

```bash
bash scripts/dashboard.sh doctor /srv/incudal-panel --json
bash scripts/dashboard.sh update-plan /srv/incudal-panel
# 核對計畫，另外備份設定、密鑰、憑證後再更新
bash scripts/dashboard.sh update /srv/incudal-panel
```

也可進入部署目錄，使用已安裝且經驗證的同版工具：

```bash
cd /srv/incudal-panel
bash panel.sh doctor --json
bash panel.sh update-plan
bash panel.sh update
bash panel.sh status
bash panel.sh logs api
```

| 入口 | 行為與限制 |
| --- | --- |
| `doctor [--json]` | 唯讀檢查雙 HTTPS origin、代理／TLS 或 Tunnel token、單 API 容器與 Node 程序、migration ledger 及公開 `/api/health`；不建立鎖或狀態目錄 |
| `update-plan` | 取得操作鎖，下載並驗證固定正式版本、目前官方部署檔、容器身分與目標 Compose；建立鎖／暫存目錄，不備份、不切換、不停機、不改 journal |
| `update` | 解析一次官方 latest 並固定正式 `vX.Y.Z`，核驗 bundle／SHA256，備份部署檔與 DB，寫入持久 journal，切換工具後自動 `up`；拒絕自動降版，同版可重新部署 |
| `recover [--json]` | 預設唯讀，檢查最後 journal 與 DB 備份雜湊並提供恢復指引；不建立鎖或狀態目錄 |
| 短入口 `force-recreate DIRECTORY` | 轉交 `panel.sh up pull --force-recreate`，重建目前釘選版本的容器；不查 latest、不換版、不還原 DB |

`update-plan` 與 `update` 各自解析 latest，兩次執行之間正式 Release 可能改變，應核對實際輸出的目標版本。診斷期間部署也可能變動；doctor 的 `ok=true`、ledger clean 或健康檢查通過，都不能證明目標 schema 相容、DNS／登入／付款／Agent 已驗收。doctor 不需要 pnpm，但 Compose 模式需要 Docker Compose，TLS 配對需要 OpenSSL。

更新將進度寫入 `.state/update-journal.json`，包含版本、artifact 雜湊、備份路徑／雜湊、`backupComplete`、切換狀態與階段；舊完成 journal 另外保留。檔案不含 secret，但含部署路徑，仍須私有保存。備份位於 `backups/before-update-*/`；DB 匯出成功、非空且記錄雜湊後才切換工具，映像全部準備成功後才停舊服務。備份是一致性快照，與後續 migration 之間仍可能有新寫入。

舊工具不會因短入口自動補齊新指令。標準手動部署僅在管理檔與該版官方 archive 逐位元組相符、容器／project／bind mounts 均符合標準時才可納管；自訂 override、私改入口、多副本或部署外掛載會拒絕。完整要求見 [Compose 指南](https://github.com/XiaoLong-Taiwan/XPayincus/blob/main/XPayincus/deploy/compose/README.md)。

### 同版容器修復與顯式版本更新

只需重建目前釘選版本時，先備份再執行其中一種：

```bash
# 統一倉庫根目錄
bash scripts/dashboard.sh force-recreate /srv/incudal-panel
# 或在部署目錄
bash panel.sh up pull --force-recreate
```

此操作保留 DB、設定與密鑰，有短暫停機；API 啟動仍可能執行 migration。它不是跨版更新或資料庫回滾，也不重裝 Agent、Incus、RFW、ZFS。單純 `panel.sh up` 只使用目前部署的 image 設定，官方部署檔換版使用 `update`；`panel.sh pull` 只拉取映像，不停止或啟動服務。來源建置部署使用同版本完整來源與 `up build`。

既有顯式版本介面仍可用，但只準備並切換 bootstrap 部署檔，不自動備份或啟動；`TARGET_ARCHIVE_SHA256` 必須是該版本 Dashboard archive 的可信 checksum：

```bash
bash panel.sh export
bash panel.sh update "$TARGET_VERSION" "$TARGET_ARCHIVE_SHA256"
bash panel.sh up
```

這不判斷 schema 相容性，也不能替代歷史版本受控遷移。工具切換完成不等於容器已換版；一旦進入重建或 migration，失敗不保證舊服務仍運行。

### 更新失敗與中斷恢復

保留 journal、備份與部署檔；若仍在數字選單，先選 `[0]` 退出，再於 shell 使用部署絕對路徑：

```bash
bash /srv/incudal-panel/panel.sh recover --json
bash /srv/incudal-panel/panel.sh doctor --json
bash /srv/incudal-panel/panel.sh status
bash /srv/incudal-panel/panel.sh logs api
bash /srv/incudal-panel/panel.sh logs db
bash /srv/incudal-panel/panel.sh logs init
```

未完成 journal 會阻擋新更新。SIGINT／SIGTERM 會記錄中斷，斷電或 SIGKILL 可能留下 running；journal 不是操作鎖或容器運行狀態的證明。只在符合條件時使用下列其中一個恢復命令：

- `bash /srv/incudal-panel/panel.sh recover --retry-preflight`：僅限 `backupComplete=false` 且已修正原因；保留舊 journal，重新下載、驗證及備份。
- `bash /srv/incudal-panel/panel.sh recover --resume-up`：僅限備份完整且雜湊可驗證、目前為目標版本、receipt／版本／部署檔相符，並人工確認 secrets、schema 與 migration 狀態相容；持鎖重新拉取／檢查並啟動。

兩者都取得既有操作鎖，均不還原資料庫。已備份但未完成切換、檔案衝突或 receipt 不符時須依備份人工修復；migration 可能已執行，不得盲目退版。直接 `docker compose` 不受 CLI 鎖保護，診斷或恢復時避免並行操作。

| 現象 | 排查方式 |
| --- | --- |
| GitHub 401／403／404 | 核對版本與唯一資產、權限／SSO、代理及出口；403 只有限流證據時才代表限流，依 reset／retry 提示處理 |
| DNS／TLS／逾時或下載失敗 | 查看失敗階段、HTTP 狀態及 curl exit code；不要跳過 SHA256 或使用不可信鏡像 |
| GHCR pull／digest 失敗 | 確認正式 tag、架構、registry 權限與連線；GitHub API token 不提供 GHCR 權限 |
| unhealthy／migration 失敗 | 查看 status 與 api／db／init 日誌；保留備份並診斷 migration，不清除 PGDATA、不用 db push 繞過 |
| HTTPS 502／登入或 WSS 失敗 | 核對雙 origin、TLS／DNS、代理 upstream、WebSocket Upgrade、secure cookie 與 runtime config；Agent 再查心跳及隧道 |

需 GitHub API 認證時，以部署目錄外、操作帳號持有且權限 600 的一般檔案保存 token，再使用 `XPAYINCUS_GITHUB_TOKEN_FILE=/srv/private/github-read-token bash panel.sh update`。不要把 token 放進命令列、`.env` 或日誌，不開 shell trace；分享日誌前移除敏感內容。

### 備份與 restore 限制

```bash
bash /srv/incudal-panel/panel.sh export /srv/private-backups/panel.dump
bash /srv/incudal-panel/panel.sh import /srv/private-backups/panel.dump --confirm-replace-incudal
```

匯出目的父目錄須存在，檔案不得已存在；備份未加密，須另外加密、離機保存並演練還原。DB archive 不含 `.env`、`secrets/`、`certs/`、`tls/`、`config/`、Incus 實例或外部儲存。必須另存原 `encryption_key`、其他 secrets 及憑證；遺失原加密金鑰無法靠 DB dump 補救。

匯入僅支援此 Compose 的 PostgreSQL 16，接受可信 custom／tar archive，不接受純 SQL；archive 可含可執行物件，`pg_restore --list` 不等於惡意內容檢查。匯入會停面板／API、先備份現有 DB，以單一交易還原；成功或失敗都保持面板停止，不啟動 API 或執行 migration。`--clean` 不保證刪除目標額外物件，不能當作任意 schema 清空或跨大版本遷移工具。還原需預留來源副本、還原前備份、DB 與 WAL 空間，外部 API／worker 須另行停止。

確認程式版本與 schema 相容、原金鑰及憑證就位，且容器內還原程序已結束後，才手動 `up`。恢復會捨棄快照後寫入，須按業務資料核對結果。程式退版、容器重建與恢復啟動都不等於 DB 回滾。

## 原生 systemd OTA

以下僅適用宿主 systemd／sudo 部署。管理後台「版本更新」頁面位於：

```text
https://admin.example.com/admin/system-update
```

頁面顯示目前版本、Git tag、commit、建置／部署時間、更新內容、可用版本、任務與日誌及回滾入口。只有超級管理員可啟動更新與回滾，API 固定為 `/api/admin/system-update/*`；使用者端沒有更新入口。

### 更新模式與一般操作

```dotenv
SYSTEM_UPDATE_APPLY_MODE=auto
SYSTEM_UPDATE_RELEASE_REPOSITORY=owner/unified-repository
```

| 模式 | 行為 |
| --- | --- |
| `auto` | 優先使用 GitHub Release OTA artifact，缺失時回退 Git tag 建置 |
| `artifact` | 只允許校驗過的 OTA artifact |
| `git` | 強制 checkout tag 並在伺服器建置 |

統一來源樹的面板位於 `XPayincus/`；舊 Git updater 假設來源根就是面板根，不能直接推定 Git 模式或 auto 回退支援統一倉 tag。統一來源應優先選擇已發布的面板 artifact，並在隔離環境確認 updater 相容性。正式環境建議明確設為 `SYSTEM_UPDATE_APPLY_MODE=artifact`，避免缺包時臨時建置。

一般更新先完成 DB 與設定備份，再由後台核對目標 Release／OTA 包並啟動，追蹤任務日誌與雙站健康。需要既有原生 CLI 時，於實際面板 release 工作目錄執行，`TARGET_VERSION` 為已核對的固定 tag：

```bash
bash scripts/apply-online-update.sh "$TARGET_VERSION"
```

保留預設 DB／支付就緒校驗，不以 `RUN_DB_CHECKS=0` 繞過。頁面開啟時會讀取最新 release tag；已是最新版時仍顯示該版本，主按鈕不可重複啟動更新。任務列表每頁最多 7 條，以分頁查閱歷史，右側顯示選中任務日誌。

### Artifact 流程

1. 讀取 Release 的 `ota-manifest.json`，匹配目前 Linux 架構的 tar.gz。
2. 清理舊 `.incudal-update-downloads` 快取並預檢磁碟空間。
3. 下載至受控快取，核對大小與 SHA256，解壓到 staging。
4. 舊布局備份目前目錄；原子布局建立新 release。
5. 執行 Prisma migration，重啟後端並等待 `/api/health`。
6. 執行 split host、生產預檢、回應標頭與日誌暴露檢查。
7. 成功後清理下載快取，按保留策略清理舊 release。

### 原子布局與程式回滾

既有原生部署可先評估遷移至原子 OTA 布局，在面板工作目錄執行：

```bash
bash scripts/migrate-ota-atomic-layout.sh
```

```text
/opt/incudal/current -> /opt/incudal/releases/<version-timestamp>
/opt/incudal/releases/v1.0.20-...
/opt/incudal/releases/v1.0.22-...
```

更新成功會將上一版 release 路徑寫入任務 `backupPath`。回滾只切換 `current`、重啟後端並重新執行 split host 驗證，**不還原 DB migrations**。僅在舊程式相容目前 schema 時才可回切；需還原 DB 時另走受控還原流程，停止所有寫入端並保留原金鑰，不能拿程式回滾取代資料庫修復。

清理會保護 `current`、本次任務 `backupPath`，以及最近成功或已回滾任務的 `backupPath`；未受保護的舊 release 預設保留 8 個。更新／回滾保留 `.env`、`server/certs`、`agent-release`、`.npm`、`.cache`，這不取代獨立備份。

### 磁碟、保留策略與除錯

```dotenv
SYSTEM_UPDATE_MIN_FREE_MB=4096
SYSTEM_UPDATE_RELEASES_KEEP=8
SYSTEM_UPDATE_BACKUP_TASKS_KEEP=3
```

| 變數 | 預設值 | 說明 |
| --- | ---: | --- |
| `SYSTEM_UPDATE_MIN_FREE_MB` | `4096` | 更新前最低可用磁碟 MB；artifact 另按包大小預留下載與解壓空間 |
| `SYSTEM_UPDATE_RELEASES_KEEP` | `8` | 原子布局中保留的未受保護舊 release 數 |
| `SYSTEM_UPDATE_BACKUP_TASKS_KEEP` | `3` | 額外保護最近成功或已回滾任務的 backupPath 數 |

磁碟不足時會於下載或 migration 前失敗並寫入任務日誌。先確認沒有執行中的更新，再檢查 `/opt/incudal/.incudal-update-downloads`、release 保護範圍與備份政策，必要時擴容；不要刪除目前或回復所需 release。

原生診斷可使用已驗證的同版 `operations.py`，不需要 pnpm；此命令假設目前位於同版工具目錄，`--env-file` 必須指向實際生效設定的私有副本：

```bash
python3 operations.py doctor --base /opt/incudal --mode native --env-file /opt/incudal/.env --proxy external --json
sudo systemctl status incudal --no-pager
sudo journalctl -u incudal -n 100 --no-pager
```

原生 ledger 檢查需要 PostgreSQL client；自訂程序管理器與外部代理設定仍須人工核對。doctor 不執行 shell 插值，不能直接解析的 env 應另備實際值副本。健康失敗先查任務與 systemd 日誌、migration、服務帳號與 current 指向，再查雙站 DNS／TLS／代理。SSH 維護建議少量長連線，避免短時間大量連線觸發限制。

## Agent 同版修復與驗收證據

Agent `reinstall`／安裝器 `--reinstall` 保留既有設定，沒有 `--force`；未指定 `--version` 時仍選擇 `latest`，可能升版，不會自動固定目前版本。同版修復必須先確認已安裝版本，再以 `--version` 指定該版本。升版使用 Agent `update` 並核對版本及 Server 相容性，詳見 [Agent 安裝](../agent/install.md)。面板容器重建或原生 OTA 不代表宿主 Agent、Incus、RFW、ZFS 已更新。

本地文件守衛、型別檢查、建置、CI 與正式 Release 是不同驗證層級。更新後仍須在目標環境驗收雙站 HTTPS、登入、付款回呼、Agent 心跳／WSS，以及隔離備份還原；實際完成範圍以對應紀錄為準。
