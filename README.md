# XPayincus

Incus（LXC／KVM）NAT VPS 銷售與管理平台，統一管理 Dashboard、Server API、Host Agent 與宿主元件。整體版本見 [VERSION](VERSION)；目前來源樹的 `v1.0.21` 為發行目標，實際已發布版本以 [GitHub Releases](https://github.com/XiaoLong-Taiwan/XPayincus/releases) 為準。`main` 入口可能領先正式版，不代表相應資產已可下載。

## Dashboard 與 Agent 分區

| 區域 | 來源與文件 | 部署位置／用途 |
| --- | --- | --- |
| Dashboard／Server | [面板 README](XPayincus/README.md)；`XPayincus/client`、`XPayincus/server` | 面板主機；使用者端、管理端、單一 API、PostgreSQL |
| Agent | [Agent README](XPayincus-Agent/README.md)；`XPayincus-Agent` | Incus 宿主；心跳、監控、出站 WSS 管理隧道與自身更新 |
| Incus／ZFS／Caddy | [宿主安裝指南](XPayincus/docs-site/docs/agent/install.md) | 宿主實例、儲存及網站反向代理；新裝預設 ZFS 並安裝 Caddy |
| RFW／ZFS 建置元件 | [元件管理](XPayincus-Agent/components/README.md) | 宿主防火牆與核心相依儲存工具；Go Agent 不直接載入核心模組 |

Agent 主動連到面板的 `wss://<面板>/api/agent/tunnel`，以 HMAC 認證，固定轉送到本機 Incus socket 與 Caddy loopback API。面板不需要直連宿主 Incus 8443 或 Caddy 2019。反向代理須允許 WebSocket Upgrade 與長連線，Server／Agent 新協定須協調更新，斷線不自動重播寫入。協定見 [TUNNEL.md](XPayincus-Agent/TUNNEL.md)。

## 最低需求與容量規劃

以下硬體數字是**未做容量壓測的小型部署建議起點，不是已驗證的最低硬體門檻**。

| 項目 | Dashboard 主機 | Agent／Incus 宿主 |
| --- | --- | --- |
| CPU／RAM | 2 vCPU／4 GiB | 2 核／4 GiB，實例負載另計 |
| 磁碟 | 40 GiB SSD，另留 DB、備份、映像與更新暫存空間 | 40 GiB 系統碟，容器、映像、ZFS 快照及備份另計 |
| 系統／架構 | Linux amd64／arm64；原生安裝限定 Debian 12+／Ubuntu 22.04+ | 建議 Debian 12／13 或 Ubuntu 22.04+，Linux amd64／arm64、systemd、root |
| 必要工具 | Compose：Docker Engine、Compose v2.20.0+、Bash、Python 3、curl、CA 憑證；細節見 Compose 文件 | Bash、curl、python3、CA、SHA256、Incus 核心能力、可用 ZFS 模組／工具；VM 另需 KVM |
| 網路 | 兩個獨立 HTTPS origin、DNS／TLS、Release 與 registry 出站 | 能到面板 HTTPS／WSS 與套件來源；實例對外埠另按需求開放 |

面板 API **只能執行一個 Node 程序**，禁止多副本／cluster／多 worker，也不能與舊 systemd 後端同時寫同一 DB。Compose 不含宿主 Agent、Incus、RFW、ZFS，也不需要 Redis。Agent unit 的 `MemoryMax=256M` 是程序限制，不是宿主最低 RAM；ZFS ARC 與實例記憶體需另行估算。受限容器或無法載入核心模組的 VPS 不保證可當完整 Incus／ZFS 宿主。

## Dashboard 安裝

以下為 Linux Bash 指令。先完整下載到私人暫存檔，下載成功才執行；入口不自動 sudo。官方帳號為 `XiaoLong-Taiwan`，curl 選項須含前面的 `-`。

```bash
(
  umask 077
  work="$(mktemp -d)" || exit 1
  trap 'rm -rf -- "$work"' EXIT
  curl -q -fsSL --proto '=https' --proto-redir '=https' \
    --connect-timeout 10 --max-time 60 \
    https://raw.githubusercontent.com/XiaoLong-Taiwan/XPayincus/main/scripts/dashboard.sh \
    -o "$work/dashboard.sh" &&
  bash "$work/dashboard.sh"
)
```

選擇「安裝 Dashboard」，再選 Compose 或宿主機。Compose 使用可信、可寫入的部署絕對路徑，例如 `/srv/incudal-panel`，準備兩個不同的使用者／管理端 HTTPS origin；使用者與管理端不共用 refresh cookie domain。預設 Nginx，也可選 Cloudflare Tunnel 或外部代理。完整流程見 [Compose 操作說明](XPayincus/deploy/compose/README.md)。

原生宿主安裝需 root、TTY 並輸入 `INSTALL`，只供最新正式版全新安裝，拒絕既有 `/opt/incudal`。入口驗證官方 Release Panel 包、SHA256、版本及封存安全後，執行同 tag 安裝器；會安裝套件、建立帳號／資料庫、寫入 systemd 與 root helpers、執行 migration，不保證整體失敗自動回滾。這與安裝 Agent／Incus 是不同操作。

若已有完整來源樹，可從倉庫根操作：

```bash
bash scripts/dashboard.sh menu /srv/incudal-panel
# 原生 Panel 全新安裝：
sudo bash scripts/dashboard.sh --host-install
# 原始碼建置部署：
cd XPayincus
bash deploy/compose/panel.sh init https://pay.example.org https://admin.example.org admin@example.org
bash deploy/compose/panel.sh up build
```

下載入口來自 main；`latest` 是 GitHub 最新正式 Release，不包含 draft／prerelease，也不等於 main。需要固定入口時，改用已確認包含該腳本的 tag／commit。

## Agent 安裝

1. 在面板新增宿主並輸入名稱，取得面板 endpoint、一次性 TOKEN 與安裝指令。
2. 在目標宿主以 root 執行面板提供的下載指令，依序輸入 endpoint 與隱藏 TOKEN，核對摘要後確認安裝。
3. 安裝器準備 Incus／ZFS、Agent 與 Caddy；回面板確認心跳、WSS、儲存池及管理功能。既有池沿用，不自動轉換儲存 driver。

`ait_` TOKEN 有效 30 分鐘、只能兌換一次；重新產生會輪換 Agent 認證。不要把 TOKEN 寫入 URL、公開日誌或命令歷史。新 ZFS loop pool 的 10 GiB 預設只是腳本初始值，生產需另規劃容量。IPv6 實例需真正 routed 前綴，單一宿主 IPv6 不等於可分配 `/64`。

完整下載命令、無 TTY TOKEN 檔案、儲存選項、認證與除錯見 [Agent 安裝與維護](XPayincus/docs-site/docs/agent/install.md)。完整來源樹可用 `sudo bash scripts/agent-menu.sh` 開啟選單；選單從您指定的可信面板下載 installer。

## 更新、強制修復與失敗恢復

先核對 Release、相容性與磁碟空間，備份 DB、設定、金鑰及憑證。下列指令假設位於完整倉庫根；遠端入口也支援相同 Dashboard 參數。既有部署操作會執行目標目錄自己的 `panel.sh`，因此路徑必須由您管理且可信。

| 操作 | 指令 | 行為 |
| --- | --- | --- |
| 更新前計畫 | `bash scripts/dashboard.sh update-plan /srv/incudal-panel` | 下載核驗與部署檢查，不備份／停機／切換 |
| Dashboard 診斷 | `bash scripts/dashboard.sh doctor /srv/incudal-panel` | 唯讀，可加 `--json` |
| Dashboard 一般更新 | `bash scripts/dashboard.sh update /srv/incudal-panel` | 固定官方 latest、核驗 SHA256、備份、持鎖更新與啟動 |
| Dashboard 同版強制重建 | `bash scripts/dashboard.sh force-recreate /srv/incudal-panel` | 執行 `up pull --force-recreate`，重建目前釘選版本容器，會短暫停機；請先備份 |
| 中斷狀態檢查 | `bash scripts/dashboard.sh recover /srv/incudal-panel` | 預設唯讀；判讀結果後才選 `--retry-preflight` 或 `--resume-up` |
| Agent 一般更新 | `sudo bash scripts/agent-menu.sh --action update --version latest` | 保留設定與認證，驗證後更新 binary／unit |
| Agent 同版強制修復 | `sudo bash scripts/agent-menu.sh --action reinstall --version v1.0.21` | 指定已發布版本重裝，可覆寫同版；沒有 `--force` |

Dashboard `force-recreate` 不選新版、不跳過校驗，也不還原 DB。固定版本 `update DIRECTORY VERSION SHA256` 僅準備部署檔，完成後另行備份及 `up`，與無版本的自動更新不同。舊部署的 `panel.sh` 若沒有新指令，需先依 Compose 文件核對工具更新方式，不能只更新入口就推定舊核心支援。

Agent 同版重裝不重做 Incus／ZFS 初始化、不兌換 TOKEN；面板授權自升級只接受較新相容版本，只更新 Agent binary。可信本地 binary 修復可用 `--action local --binary FILE --sha256 HASH`，HASH 須為可信來源 64 位 SHA256；本機模式不提供遠端 manifest 的防降版保障。

原生 systemd 面板使用獨立 OTA；Compose 不在容器內執行 systemd／sudo OTA。程式回滾不回滾資料庫 migration。操作細節見 [Dashboard 更新與恢復](XPayincus/docs-site/docs/guide/ota-update.md)。

## 除錯與備份

| 症狀 | 優先檢查 |
| --- | --- |
| 下載 403／429 | 確認 URL、GitHub repo／權限、代理及出口政策；區分 raw、Release、registry 與面板 API，不能靠換 curl／wget 保證解決 |
| Dashboard 更新中斷 | 先 `doctor` 與唯讀 `recover`，看部署狀態、鎖、映像、DB、磁碟與備份；勿刪鎖檔或直接重跑 migration |
| 網頁可開但 API／登入失敗 | 兩個 HTTPS origin、同源 `/api` 代理、cookie、單一 API、DB 與日誌 |
| Agent 離線／簽名失敗 | `systemctl status incudal-agent`、`journalctl -u incudal-agent -n 100`、DNS、TLS、NTP、endpoint、憑證輪換 |
| 心跳正常但無法管理 | WSS Upgrade／長連線、Server／Agent 協定、Incus socket、Caddy `127.0.0.1:2019` |
| ZFS／監控異常 | 核心模組、`zpool status`、Incus pool、state 權限／空間與 spool ACK；Agent 重裝不修核心模組 |

Compose DB 匯出與匯入（備份父目錄先存在，匯出目的檔不得存在）：

```bash
bash /srv/incudal-panel/panel.sh export /srv/private-backups/panel.dump
bash /srv/incudal-panel/panel.sh import /srv/private-backups/panel.dump --confirm-replace-incudal
```

匯入僅接受可信 PostgreSQL custom／tar archive，會停止面板並先備份現有資料，成功或失敗都保持停止；確認版本／schema、金鑰及憑證後才手動 `up`。DB 備份未加密，也不含 `.env`、secrets、Incus 憑證或實例資料，須另外安全保存與離機備份。舊宿主首次遷移見 [匯出與匯入指南](XPayincus/server/scripts/LEGACY_HOST_EXPORT.md)。

## 開發、發行與文件

pnpm workspace 位於 `XPayincus/`，需要 Node.js 20+（建置使用 22）、pnpm 9.14.2、PostgreSQL 16；開發／測試指令見 [Dashboard README](XPayincus/README.md)。Agent 建置見 [Agent README](XPayincus-Agent/README.md)。

根 `.github/workflows` 是 CI／發行入口，子目錄 workflow 保留歷史參考。符合根版本的 `v*` tag 流程在 CI、映像與資產成功後發布 GitHub Release；手動 release 流程會產生映像與 Actions artifacts，不建立 GitHub Release，也不自動部署。版本、SHA256 manifests、GHCR 多架構映像與升級契約見 [RELEASE.md](RELEASE.md)。ZFS 資產是 source-only builder，並非已建置核心模組。

- [Dashboard 部署與維運](XPayincus/README.md)
- [Compose 安裝、更新、診斷及備份](XPayincus/deploy/compose/README.md)
- [Agent 安裝與維護](XPayincus/docs-site/docs/agent/install.md)
- [更新與 OTA 適用範圍](XPayincus/docs-site/docs/guide/ota-update.md)
- [文件站](XPayincus/docs-site/README.md)

歷史交接／release notes 不代表目前 checkout、CI、Release 或線上版本。本地 mock、建置、正式資產發布與 Linux 真機驗收是不同證據，實際部署仍需驗證登入、Agent 隧道、交付與備份還原。歷史面板 v1.5.9 遷移至統一 v1.0.x 需依發行文件受控處理，不能自動當作降版。
