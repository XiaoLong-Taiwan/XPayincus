# XPayincus Host Agent

統一倉庫的 Go 宿主監控元件，部署於 Incus 宿主機，以 HMAC-SHA256 簽名呼叫 `POST /api/agent/heartbeat`，回報資源、實例狀態與流量，並依心跳回應自升級。不執行實例建立、銷毀或啟停等下發任務，也不放入面板 Compose。

產品版本以 [根 VERSION](../VERSION) 為準，目前準備 `v1.0.6`（未發布），本目錄 `VERSION` 須同步。統一發行入口及限制見 [RELEASE.md](../RELEASE.md)。

## 宿主元件整合

Agent 來源樹納入 [RFW](components/rfw/README.md) 與 [ZFS builder](components/zfs/README.md)，實體路徑分別為 `components/rfw` 與 `components/zfs`。以宿主元件 bundle 與 [管理文件](components/README.md) 整合，保留獨立工具鏈及既有資產名稱，不將 Rust/eBPF 或 ZFS 核心功能嵌入 Go Agent。

Go 程序仍只負責監控、心跳與自身二進位升級；不自動啟停 RFW、不下載或載入 eBPF、不執行 DKMS／`modprobe`。bundle 是同一統一 Release 的邏輯元件集合，不新增封裝資產，不代表 Agent 安裝器或自升級會安裝全部元件。宿主權限、核心相容性、規則、服務與回復由管理者分別控管。

## 設定與執行

預設設定檔為 `/etc/incudal-agent/config.yaml`，內容參考 `config.example.yaml`：

```yaml
panel_url: "https://pay.example.org"
agent_id: "<面板產生的 Agent ID>"
agent_secret: "<面板產生的私密金鑰>"
heartbeat_interval_seconds: 60
request_timeout_seconds: 10
```

請使用面板產生的設定，限制檔案權限，不要提交金鑰。可用 `INCUDAL_PANEL_URL`、`INCUDAL_AGENT_ID`、`INCUDAL_AGENT_SECRET`、`INCUDAL_HEARTBEAT_INTERVAL_SECONDS`、`INCUDAL_REQUEST_TIMEOUT_SECONDS` 覆寫。

以下從本目錄執行，需要 Go 1.22+：

```bash
go run ./cmd/incudal-agent -config /etc/incudal-agent/config.yaml -once
go run ./cmd/incudal-agent -config /etc/incudal-agent/config.yaml
```

`-once` 只執行一次心跳，不執行自動升級。這些是參考指令，本次文件整理未執行。

## 安裝與資源限制

從管理後台產生 **Agent** 安裝 TOKEN（`ait_`，30 分鐘有效、只能兌換一次），在目標宿主機執行。此 TOKEN 與宿主初始化 TOKEN 不同；產生新 Agent TOKEN 會輪換 Agent 憑證，使舊 Agent 憑證失效。安裝模板位於 `../XPayincus/server/templates/agent-install.sh`，由面板 `/api/agent/install.sh` 提供。

安裝器從面板同源 `/api/agent/manifest.json` 選擇 amd64／arm64，下載、核對 SHA256 後原子安裝至 `/usr/local/bin/incudal-agent`，建立設定及 systemd 服務，執行單次心跳後啟動服務。自訂 `INCUDAL_AGENT_BINARY_URL` 必須同時提供 `INCUDAL_AGENT_BINARY_SHA256`。

### 獨立互動與參數入口

先從可信的面板下載模板再執行，避免把 TOKEN 放進下載 URL 或 shell 歷史；正式環境使用 HTTPS。以下指令在 Linux 宿主機執行，需要 root、Bash、systemd 及 curl：

```bash
curl -q -fsS --proto '=https' https://panel.example.org/api/agent/install.sh -o agent-install.sh
sudo bash agent-install.sh
```

依提示輸入面板地址（僅 HTTP(S) origin，例如 `https://panel.example.org:8443`）及隱藏輸入的 Agent TOKEN。地址及 TOKEN 分開輸入，不需執行整套宿主初始化。管線執行時仍從 `/dev/tty` 讀取互動值；沒有 TTY 時必須提供參數或既有憑證環境變數。

自動化入口使用 root 擁有、權限 `0600`、只含 TOKEN 的一般檔案，由秘密管理工具提供：

```bash
sudo bash agent-install.sh --panel-url https://panel.example.org --token-file /root/agent-install.token
```

不提供明文 `--token` 參數，避免出現在程序參數及歷史；相容既有面板命令所用 `INCUDAL_PANEL_URL`／`INCUDAL_AGENT_INSTALL_TOKEN` 環境變數。執行後由管理者移除 TOKEN 檔案。安裝器關閉 shell trace、遮蔽 dry-run 金鑰、透過 curl stdin 傳遞兌換 URL，不跟隨兌換轉址，也不執行兌換回應中的 shell 程式碼。反向代理須自行遮蔽既有 `/api/agent/install-config/:token` 路徑的存取日誌，勿記錄完整請求 URL。

### 僅重裝 Agent 與本機 binary

```bash
sudo bash agent-install.sh --reinstall
sudo bash agent-install.sh --reinstall --binary /root/build/incudal-agent
sudo bash agent-install.sh --reinstall --binary /root/build/incudal-agent --sha256 <可信的64位SHA256>
```

`--reinstall` 要求已有 `/etc/incudal-agent/config.yaml`，逐位元組保留設定與憑證，更新 Agent binary 及 Agent systemd unit，重啟 `incudal-agent`；不接受新地址／TOKEN。若需更換面板或輪換憑證，使用獨立安裝入口。地址讀取支援安裝器產生的 `panel_url: "…"` 格式；自訂 YAML 格式須先調整。`--binary` 接受已編譯的未壓縮 Linux amd64／arm64 binary，不下載 manifest 或 binary，也不執行編譯；可與首次安裝的地址及 TOKEN 檔案搭配。預設計算本機 SHA256 並驗證暫存副本；指定 `--sha256` 時另核對可信雜湊。自行計算的雜湊只確認複製一致性，不證明來源可信。

所有入口只管理 Agent binary、Agent 設定及 `incudal-agent.service`，不安裝、移除、重啟或改寫 Incus／RFW／ZFS。沒有既有設定時不可使用保留設定的重裝模式。本機重裝不需要下載，但單次冒煙仍需要連到面板；`-once` 不觸發自動升級。

### 失敗與重試

- manifest／binary 下載使用連線逾時 10 秒、單次最多 120 秒，curl 對暫時性錯誤最多重試 2 次、間隔 2 秒，重試視窗 360 秒；永久 HTTP 錯誤、SHA256 不符及解壓失敗不盲目重試。
- 預檢、下載及 SHA256 檢查在 TOKEN 兌換前完成。此階段失敗可修正網路、權限或檔案後重跑，TOKEN 仍受原本 30 分鐘時效限制。
- TOKEN 兌換只有一次請求，連線逾時 10 秒、總逾時 30 秒。403／404、兌換回應遺失、格式不符或後續冒煙失敗時，先確認原因，再從管理後台產生新 Agent TOKEN；不自動重送或儲存兌換後的秘密供續跑。
- 冒煙在替換前執行，失敗保留原安裝；替換後服務檢查失敗會回復舊 binary、設定、unit 與服務狀態。回復不完整時保留備份並報錯，須人工處理，不能無限循環重啟安裝。面板憑證輪換無法由本機回復撤銷，舊設定即使還原也可能無法連線。
- 保留設定的重裝可在修正問題後重跑；服務由既有 `Restart=always`／`RestartSec=5` 處理執行期重啟，安裝器不改動心跳或 ping 的重試行為。

- 預設心跳 60 秒，最小 30 秒。
- 每次最多回報 500 個實例，狀態讀取並發為 3，非執行中實例不額外讀取 `/state`。
- 成功心跳日誌約每 10 分鐘記錄，失敗約每分鐘記錄，並保留首次日誌。
- 安裝模板設定 `CPUQuota=20%`、`MemoryMax=256M`、`TasksMax=128` 及 journal 速率限制。

二進位自升級不會更新既有 systemd service；舊安裝可使用 `--reinstall` 套用資源與日誌限制。

## 一鍵授權更新

宿主詳情的 Agent 區塊在 Agent 在線、啟用且發現較新版本時顯示「一鍵更新 Agent」。確認視窗列出目前及目標版本，明確授權替換 Agent binary 並重啟 Agent 服務；只有宿主擁有者或管理員可操作。不輪換憑證，不更新 Incus／RFW／ZFS 或 systemd unit。

`POST /api/agent/hosts/:hostId/upgrade` 要求 JSON `{ "confirm": true, "targetVersion": "v1.0.6" }`（版本僅為範例）。後端重新驗證目標版本、平台與最低 updater 版本，固定當次 manifest 的版本、雜湊及同源代理下載指令；不接收自訂 URL 或命令。版本已變更時須重新整理並再次確認。較新或相同版本不降級；未知版本、離線、停用及不相容平台不能更新。

未授權心跳不再自動下發新版。每次授權只下發一次，重複請求不替換進行中的目標。狀態 API 的 `agent.upgrade` 提供 `pending`（等待心跳）、`delivered`（已下發）、`succeeded`（後續 HMAC 心跳版本達到目標或更新）、`unconfirmed`（逾時未確認），附目標、請求／下發及到期時間。成功只代表新版心跳，並不證明所有宿主功能健康。

Go Agent 保留原本最多 5 分鐘隨機延遲與 10 分鐘執行逾時。面板等待視窗為兩次心跳間隔加 20 分鐘；下發或 HTTP 成功都不代表安裝成功。下載／校驗／重啟錯誤目前只記錄宿主 `journalctl -u incudal-agent`，舊 Agent 無細分進度／錯誤回報；未確認時先查心跳和日誌，再明確重試。下發回應遺失也不自動重送，避免無限執行。

授權及狀態保存在單一 API 程序記憶體，不新增資料庫遷移；API 重啟後清除未下發授權與狀態，需要重新確認。已下發的 Agent 更新可能仍在執行，重啟 API 不會取消宿主工作。授權綁定 Agent ID，輪換憑證後不沿用；請求以 `host.agent_upgrade_request` 留存稽核日誌。不可部署多個 API 副本。

本機驗證：在 `XPayincus/` 執行 `pnpm --filter server test:agent-upgrade`、Agent 相關守衛、前後端 type-check 及雙端 build；在本目錄執行 `go test ./...`。Linux 真機驗收需用測試宿主：取消確認不應呼叫更新 API，確認後依序看到等待／下發／新版心跳；另驗證未授權心跳、非擁有者、離線、較新版本及校驗失敗。真機驗收不包含在本機守衛通過的證據內。

Agent 只接受目前 `panel_url` 同源下載 URL。下載後先核對 SHA256，再解壓（若適用）、寫入暫存檔、備份並原子替換舊檔，最後重啟 `incudal-agent`。首次使用不含升級執行器的舊版 Agent，需手動重新安裝一次。

面板的來源設定只放在後端，不將 GitHub token 傳入宿主：

```dotenv
INCUDAL_RELEASE_REPOSITORY=owner/unified-repository
INCUDAL_AGENT_RELEASE_REPOSITORY=
INCUDAL_AGENT_RELEASE_TAG_PREFIX=
```

舊 `INCUDAL_AGENT_RELEASE_REPOSITORY` 非空時優先且預設使用 `agent-v*` tag；統一來源預設 `v*`。明確空前綴代表 `v*`，`agent-` 代表舊格式。兩個來源均未設定仍沿用舊獨立倉庫預設值。私有來源使用 `INCUDAL_AGENT_RELEASE_TOKEN`，修改後重啟後端。Compose 需另將設定注入 API 容器。

遠端代理要求同一 Release 具備兩架構的未壓縮二進位 `xpayincus-agent-${VERSION}-linux-{amd64,arm64}`。只有 `.gz`、manifest、原始碼 zip 或 Actions artifacts 不足以使用遠端更新。也可設定 `INCUDAL_AGENT_RELEASE_DIR=/opt/incudal/agent-release`，將既有格式 `manifest.json` 與其列出的兩架構 `.gz` 一起放入該目錄。

## 建置與發行

從統一倉庫根目錄執行：

```bash
bash scripts/build-agent-release.sh
```

此 wrapper 讀取根版本並呼叫本目錄 `scripts/build-release.sh`，輸出未壓縮二進位、單檔 `.gz` 及舊格式 `manifest.json`；manifest 雜湊對應壓縮檔位元組。獨立執行本目錄腳本時預設讀取本目錄 `VERSION`，支援預發行後綴。

根 `.github/workflows/release.yml` 由手動或相符 `v*` tag 觸發；手動只上傳 Actions artifacts，tag 流程成功後發布統一 GitHub Release，不會因 Agent `VERSION` 改變就自動發布獨立 `agent-v*` Release。RFW 由根 `scripts/build-rfw-release.sh` 從 `components/rfw` 建置，ZFS 由根 `scripts/package-zfs-source.sh` 從 `components/zfs` 封裝 source-only 包；兩者不進入 Agent 舊格式 `manifest.json` 或面板 OTA manifest。版本、SHA256 與目標主機升級須有各自的執行證據。本次未建置、發布或驗證升級。
