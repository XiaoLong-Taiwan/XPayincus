# XPayincus Host Agent

統一倉庫的 Go 宿主監控元件，部署於 Incus 宿主機，以 HMAC-SHA256 簽名呼叫 `POST /api/agent/heartbeat`，回報資源、實例狀態與流量，並依心跳回應自升級。不執行實例建立、銷毀或啟停等下發任務，也不放入面板 Compose。

產品版本以 [根 VERSION](../VERSION) 為準，目前 `v1.0.2`，本目錄 `VERSION` 須同步。統一發行入口及限制見 [RELEASE.md](../RELEASE.md)。

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

從管理後台重新產生節點／Agent 安裝命令，在目標宿主機執行。安裝模板位於 `../XPayincus/server/templates/agent-install.sh`，由面板 `/api/agent/install.sh` 提供。安裝 token 有時效且只能使用一次；失敗後應重新產生命令。

安裝器從面板同源 `/api/agent/manifest.json` 選擇 amd64／arm64，下載、核對 SHA256 後原子安裝至 `/usr/local/bin/incudal-agent`，建立設定及 systemd 服務，執行單次心跳後啟動服務。自訂 `INCUDAL_AGENT_BINARY_URL` 必須同時提供 `INCUDAL_AGENT_BINARY_SHA256`。

- 預設心跳 60 秒，最小 30 秒。
- 每次最多回報 500 個實例，狀態讀取並發為 3，非執行中實例不額外讀取 `/state`。
- 成功心跳日誌約每 10 分鐘記錄，失敗約每分鐘記錄，並保留首次日誌。
- 安裝模板設定 `CPUQuota=20%`、`MemoryMax=256M`、`TasksMax=128` 及 journal 速率限制。

二進位自升級不會更新既有 systemd service；舊安裝須重新執行管理後台產生的命令以套用資源與日誌限制。

## 自動升級

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
