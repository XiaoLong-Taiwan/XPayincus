# Agent 安裝與維護

Agent 在 Incus 宿主機執行，回報資源、實例狀態、流量及監控歷史，並主動建立出站 WSS，讓面板透過固定本機 API 管理 Incus／Caddy。Agent、Incus、ZFS、Caddy 與 RFW 保留宿主部署，面板 Compose 不包含這些服務。

本文依目前來源樹整理。根 `VERSION` 的 `v1.0.21` 是發行目標；正式可用版本以 GitHub Release 與實際部署版本為準。`main` 上的名稱 onboarding、安裝腳本或新隧道能力可能領先穩定版，不代表已發布，使用前須確認 Server／Agent／安裝器相容。

## 元件分工與宿主需求

| 元件 | 工作 |
| --- | --- |
| Agent | HMAC 心跳、監控採樣／spool、經授權的 Agent binary 自升級，以及出站管理隧道。 |
| Incus | 容器／虛擬機、映像、網路、儲存池及實例生命週期。 |
| ZFS | 宿主儲存核心模組、pool／dataset 與快照；新裝預設 ZFS，既有池不自動轉換。 |
| Caddy | 宿主網站反向代理與憑證服務，管理 API 固定在 `127.0.0.1:2019`。 |
| RFW | 獨立 eBPF/XDP 防火牆元件；Go Agent 不載入 eBPF／ZFS 核心模組，不自動啟停 RFW 或執行 DKMS。 |

支援的 Agent binary 為 Linux amd64／arm64（x86_64／aarch64）。宿主安裝流程建議 Ubuntu 22.04+、Debian 12／13；Debian 11 保留相容能力，Debian 10 以下會拒絕。其他 Linux 不等於受整套 installer 支援。

需要 root、Bash、運作中的 systemd、curl、CA 憑證、SHA256 工具，以及 `.gz` 使用的 gzip。manifest／版本檢查需 python3；目前 `ait_` 首次安裝可透過 apt-get 補裝，重裝缺少時停止。Incus 核心功能及 ZFS 工具／模組、`/dev/zfs` 必須可用，虛擬機另需 KVM。受限容器或不能載入核心模組的 VPS 不保證可作宿主。

**小型部署建議起點，未做容量壓測**：宿主 2 核、4 GiB RAM、40 GiB 系統碟，額外預留容器、映像、快照及備份空間。實際需求須依實例數、負載、ZFS ARC 與磁碟 I/O 評估。Agent unit 的 `MemoryMax=256M` 是程序上限，不能當成宿主最低 RAM；ZFS ARC 設定也不是 ZFS 總記憶體硬上限。

## 面板 endpoint、出站與 IPv6

面板 endpoint 應是可信且有有效 TLS 憑證的 HTTPS origin，例如 `https://panel.example.org` 或 `https://panel.example.org:8443`，不帶帳密、路徑或 query。Agent 心跳走 `POST /api/agent/heartbeat`，管理通道實際為：

```text
wss://panel.example.org/api/agent/tunnel
WebSocket subprotocol: xpayincus-tunnel-v1
```

若面板使用自訂 HTTPS 埠，WSS 使用相同埠。installer 接受 HTTP origin 不代表隧道支援明文管理；正式部署使用 HTTPS。宿主需解析面板 DNS、連出 HTTPS／WSS，安裝期間還需到達套件來源；面板需能取得 Release 或準備完整本地資產。反向代理／WAF 需允許 WebSocket Upgrade、長連線及 `x-incudal-*` HMAC headers。

目前正常管理不要求面板直連宿主 Incus 8443／Caddy 2019。Agent 轉送至 `/var/lib/incus/unix.socket` 與本機 `127.0.0.1:2019`，不提供任意 URL 或通用 TCP 代理。實例 SSH／NAT 映射及網站對外埠仍依產品配置開放。Server／Agent 新串流 frame 沒有舊版自動降級；心跳在線不代表 WSS 或所有交付功能已驗證。

IPv6 實例使用 routed 模式，需要供應商真正路由到宿主的可用前綴、正確轉送及防火牆。只有宿主單一 IPv6 地址不能推定有 `/64` 可分配。只有明確 routed 能力及合法前綴回報，面板才會自動採用 routed 模式；IPv6 NAT 舊值僅保留歷史相容。純 IPv6 宿主也需能到達面板、套件及下載來源，WARP 出站準備失敗時不保證有 IPv4 出站。

## 首次建立節點

目前來源樹流程如下；若正式部署畫面不同，先確認面板版本：

1. 在面板新增宿主，只填名稱。管理員填完整名稱，一般使用者填 `PEER<使用者ID>-` 後綴；完整名稱為 2–64 個英數、底線或連字號，不需先填宿主公開 IP／Incus 埠。
2. 取得分開顯示的面板 endpoint 與一次性 TOKEN，確認 endpoint、節點及 TOKEN 配對正確。`ait_` TOKEN 有效 30 分鐘、只能兌換一次；重新產生會輪換 Agent 憑證，舊 Agent 認證會失效。
3. 在目標 Linux 宿主以 root 下載完整安裝器，再執行並分開輸入 endpoint 與隱藏 TOKEN。核對安裝摘要中的面板、版本及儲存計畫，確認後開始。
4. 安裝後回面板確認 Agent 在線；目前新建頁的驗證讀 Agent 心跳。再確認 WSS、Incus、儲存池與所需 Caddy 功能，不能只以 systemd active 當作交付驗收。

以下指令在 Linux **root shell** 執行；需要時先 `sudo -i`。私人暫存下載成功後才執行，結束清除暫存，不將 TOKEN 放入下載 URL 或 shell 歷史：

```bash
(
  umask 077
  work="$(mktemp -d)" || exit 1
  trap 'rm -rf -- "$work"' EXIT
  curl -q -fsS --proto '=https' --connect-timeout 10 --max-time 60 \
    https://panel.example.org/api/agent/install.sh -o "$work/agent-install.sh" &&
  bash "$work/agent-install.sh"
)
```

沒有 TTY 的自動化，可將最後一行改為：

```bash
bash "$work/agent-install.sh" --panel-url https://panel.example.org \
  --token-file /root/agent-install.token --yes
```

這一行必須在上述暫存區塊內執行。TOKEN 檔需由秘密管理工具提供，為目前執行者擁有、權限 0600 的一般檔案，不可為 symlink，完成後自行移除。沒有明文 `--token` 參數；`--yes` 只略過確認。相容既有 `INCUDAL_PANEL_URL`／`INCUDAL_AGENT_INSTALL_TOKEN` 環境變數及 UUID 宿主初始化 TOKEN，UUID 走宿主初始化後再安裝 Agent。

### 安裝器實際做什麼

目前 `ait_` 流程先預檢，透過同源 `/api/agent/manifest.json` 選擇架構、固定版本及 SHA256，下載驗證完成後準備 Incus／ZFS，再兌換 TOKEN。自訂 `INCUDAL_AGENT_BINARY_URL` 必須同時提供 `INCUDAL_AGENT_BINARY_SHA256`。

新池預設 ZFS loop、10 GiB，這是腳本預設，不是生產容量建議。執行前可依容量設定 `INCUS_STORAGE_SIZE=40GiB`、`INCUS_STORAGE_POOL`、`INCUS_STORAGE_DRIVER=zfs|dir|auto`。既有 default profile root 優先沿用其 pool；已有池不改 driver、不清空容器，不接受任意磁碟／source。ZFS 不可用時明確要求 zfs 的安裝會失敗，不應當成已自動改用 dir。

TOKEN 交換端點 `/api/agent/install-config/:token?bootstrap=1` 目前提供固定五行：Agent ID、secret、base64 面板憑證、宿主安裝狀態及同源 Caddy installer URL。安裝器嚴格解析，不執行回傳 shell 程式碼；舊兩／四行回應須先更新面板。面板憑證配對檢查失敗會回 503 且不消耗 TOKEN。交換不跟隨轉址，反向代理存取日誌需遮蔽含 TOKEN 的路徑。

兌換後安裝 Caddy、宿主捷徑並按狀態匯入首次 Incus trust。暫存 binary 與設定先跑一次心跳冒煙，再原子替換正式檔案、重啟及檢查服務。Agent 安裝失敗可嘗試回復 binary／設定／unit／服務狀態，但不回復宿主初始化、Caddy 或面板已輪換的認證。

首次顯示「待驗證」時不立即移除舊 trust。依面板完成驗證後，必要時在宿主執行 `incudal --refresh-agent-trust`。此命令透過既有 HMAC 取得、驗證面板憑證，新連線確認後才移除舊指紋。`AGENT_AUTH_REQUIRED`／`AGENT_SIGNATURE_INVALID` 應重新配對，不可略過認證或盲目信任下載憑證。舊腳本若提示面板需直連宿主 8443，先核對版本，勿為此公開管理埠。

面板 `client.crt`／`client.key` 僅在兩檔都不存在時生成；半套、無法讀取或配對不符會拒絕啟動。遷移／災備請成對還原原檔，不要刪除半套檔案觸發新憑證。

## 狀態、日誌、更新與同版修復

根 `scripts/agent-menu.sh` 提供數字選單：安裝 Incus／ZFS 與 Agent、保留設定重裝、更新至最新穩定版、本機 binary 重裝、狀態及最近 100 行日誌。選單只下載面板 `/api/agent/install.sh`，實際初始化由 installer 執行；互動讀 `/dev/tty`，無控制終端則用參數。

以下是 **main 來源樹入口，可能有尚未發布能力**。要固定版本，改用已確認含腳本且與面板相容的 tag／commit：

```bash
(
  umask 077
  work="$(mktemp -d)" || exit 1
  trap 'rm -rf -- "$work"' EXIT
  curl -q -fsS --proto '=https' --connect-timeout 10 --max-time 60 \
    https://raw.githubusercontent.com/XiaoLong-Taiwan/XPayincus/main/scripts/agent-menu.sh \
    -o "$work/agent-menu.sh" &&
  bash "$work/agent-menu.sh"
)
```

以下假設審閱過的腳本已保存於 `/root/agent-menu.sh`、`/root/agent-install.sh`；版本僅是用法範例，必須有對應可用 Release：

```bash
bash /root/agent-menu.sh --action status
bash /root/agent-menu.sh --action logs
bash /root/agent-menu.sh --action update --version latest
bash /root/agent-menu.sh --action reinstall --version v1.0.21
bash /root/agent-menu.sh --action local --binary /root/build/incudal-agent \
  --sha256 '<可信的64位SHA256>'
bash /root/agent-install.sh --reinstall --binary /root/build/incudal-agent \
  --sha256 '<可信的64位SHA256>'
```

`update`／`reinstall` 都使用 installer `--reinstall`：逐位元組保留既有設定與認證，更新 binary 及 systemd unit 並重啟，不重新準備 Incus／ZFS 或兌換 TOKEN。**同版也會重裝，適合強制修復同版檔案／套用新 unit，沒有 `--force` 參數。** 無既有設定不能重裝；重裝不能提供新 endpoint／TOKEN。若要換面板或輪換認證，須明確重新配對。

目前來源樹的選單已支援 `--action local --binary FILE --sha256 HASH`，並將雜湊傳給 installer；選單的 `--sha256` 僅適用 `local`，HASH 必須是可信來源的 64 位十六進位 SHA256。舊選單腳本需更新後才能使用此參數。本機 binary 必須是符合宿主架構、未壓縮的已編譯 Linux 執行檔，不會編譯或下載 manifest／binary，但仍需連面板冒煙。自行計算 SHA256 只能確認複製一致性；本機模式不提供 manifest 版本防降級，管理者需自行驗證來源及版本。

`reinstall`／安裝器 `--reinstall` 未指定 `--version` 時仍選擇 `latest`，可能升版，不會自動固定目前版本。同版修復必須先確認已安裝版本，再以 `--version` 指定該版本。

遠端模式拒絕降版、未知 canonical 版本及不滿足 `minimumUpdaterVersion` 的替換；舊 binary 不支援 `-version` 時，先取得可信本機 binary 修復。快取回退會顯示實際版本與「無法確認最新」，不代表取得最新穩定版。

面板「一鍵更新 Agent」只在在線、啟用、有較新相容版本時由擁有者／管理員確認；授權後透過心跳下發同源 URL、固定版本與 SHA256。Go updater 對同版不替換，只改 Agent binary，不更新 unit、Incus、Caddy、RFW、ZFS。下載、下發或 HTTP 成功不等於升級成功，需確認新版健康心跳；較舊 Agent 可能沒有細分進度。遇到未確認狀態，先查日誌再重試，同版修復用保留設定重裝。

## 精確路徑與資源保護

| 項目 | 預設路徑／設定 |
| --- | --- |
| binary／自升級備份 | `/usr/local/bin/incudal-agent`／`/usr/local/bin/incudal-agent.bak` |
| 設定 | `/etc/incudal-agent/config.yaml`，root:root、0600 |
| systemd unit | `/etc/systemd/system/incudal-agent.service` |
| 私人 state | `/var/lib/incudal-agent`，0700 |
| 歷史／監控 spool | `/var/lib/incudal-agent/history`／`/var/lib/incudal-agent/monitoring-v2` |
| 升級狀態／鎖 | `/var/lib/incudal-agent/upgrade.json`／`/run/incudal-agent-upgrade.lock` |
| Incus／Caddy 本機 API | `/var/lib/incus/unix.socket`／`http://127.0.0.1:2019` |
| 宿主捷徑 | `/usr/local/bin/incudal`、`/usr/local/bin/k` |
| 元件狀態 JSON | `/run/xpayincus/rfw-status.json`、`/run/xpayincus/zfs-status.json` |
| ARC 設定 | `/etc/modprobe.d/99-zfs-arc.conf` |

目前來源樹的選單與 installer 都優先使用 `INCUDAL_CONFIG_FILE` 指定的設定檔，其次使用 `${INCUDAL_CONFIG_DIR}/config.yaml`，皆未指定時預設為 `/etc/incudal-agent/config.yaml`。舊選單與 installer 腳本需更新，以確保使用相同的設定路徑優先順序。宿主信任工具使用另一個變數 `INCUDAL_AGENT_CONFIG_FILE`。請確保選單、unit 與信任工具指向同一設定。重裝擷取 endpoint 需要安裝器產生的 `panel_url: "…"` 格式，不保證任意 YAML 排版可用。

Agent 預設每 60 秒心跳，範圍 30–3600 秒；一次最多 500 個實例，狀態讀取並發 3，非執行中不額外請求 `/state`。成功日誌首筆及約每 10 分鐘一次，失敗首筆及約每分鐘一次。unit 設 `CPUQuota=20%`、`MemoryMax=256M`、`TasksMax=128`、`LogRateLimitIntervalSec=30s`、`LogRateLimitBurst=120`。binary 自升級不改舊 unit，使用保留設定重裝套用新模板。

預設 `state_dir` 為 `/var/lib/incudal-agent`，`spool_max_bytes=16777216`、`spool_retention_hours=72`，請保持私人可寫及持久化。面板端的同名 `INCUDAL_AGENT_STATE_DIR` 是不同程序的設定，預設服務帳號 `~/.local/state/xpayincus/agent`，須位於倉庫外私人絕對目錄並持久掛載；後端只允許單一 Node 程序，檔案 journal 不支援多副本協調。

## 故障排查與重試

先在宿主做唯讀檢查，分享日誌前移除 TOKEN／secret：

```bash
systemctl --no-pager status incudal-agent incus caddy
journalctl --no-pager -u incudal-agent -n 100
/usr/local/bin/incudal-agent -version
getent ahosts panel.example.org
timedatectl status
incus query /1.0
incus storage list
zpool status
zfs list
curl -q -fsS --connect-timeout 5 --max-time 10 http://127.0.0.1:2019/config/ -o /dev/null
```

| 症狀 | 檢查與處理 |
| --- | --- |
| 403／簽名錯誤 | 分辨 TOKEN、HMAC、WAF 或面板連 GitHub 被拒。核對 endpoint、節點啟用、憑證是否輪換、HMAC headers、UTC 時間與 NTP；不關閉驗證。 |
| DNS／TLS／時間偏差 | 檢查 A／AAAA、IPv4／IPv6 出站、CA chain、憑證主機名及期限、兩端時間；不使用 `-k` 繞過驗證。 |
| 心跳正常但不能操作 | 檢查 WSS Upgrade／長連線、Server／Agent frame 相容性、Incus socket 權限與 Caddy loopback API。隧道中斷不自動重播寫入，先查 operation／資源結果。 |
| ZFS 安裝／pool 錯誤 | 檢查核心版本、headers、DKMS／預編譯模組、`modinfo zfs`、`/dev/zfs`、空間與 `zpool status`。Agent 重裝不修核心；無效既有 root pool 需先修復，不刪池重建。 |
| 監控空白／缺口 | 查 state 權限／磁碟／ACK、Incus socket、`/proc/pressure/` 及元件 exporter。狀態 JSON 須是有效一般檔、約 5 分鐘內更新；unavailable 或缺少 PSI 不等於數值為零。 |
| 舊 binary URL 回 400 | 舊 installer 可能把時間戳放到保留 `v` 參數；更新面板模板，確認使用獨立 `cache_bust`、固定版本 `v` 及 SHA256，再取命令。 |
| manifest 架構資料解析錯誤 | 核對實際面板模板與雙架構資產；舊腳本可能不能解析單行 JSON，先更新面板，不以空雜湊略過檢查。 |

下載／雜湊校驗在 `ait_` 兌換前，這階段失敗可修正後在 TOKEN 有效期內重跑。TOKEN 交換只有一次請求，連線逾時 10 秒、總逾時 30 秒，不自動重送；回應遺失、已消耗／不確定、回應格式不符或後續失敗時，先查原因再產生新 TOKEN。新 TOKEN 輪換憑證不能由本機回復撤銷。保留設定重裝則可修正問題後重跑。

監控 schemaVersion 2 提供 avg／min／max／count／coverage、累計差值／重設辨識與元件事件。缺少指標不補零；spool 有大小／時效限制。面板最多保留 30 天，但樣本最多 8192 筆或 1536 KiB、元件事件最多 512 筆或 256 KiB，超限提早截斷，不能保證完整 30 天，也不取代計費資料或備份。

## 面板端 Release 設定與本機建置

以下設定放面板後端，GitHub 私有 token 不送入宿主：

```dotenv
INCUDAL_RELEASE_REPOSITORY=owner/unified-repository
INCUDAL_AGENT_RELEASE_REPOSITORY=
INCUDAL_AGENT_RELEASE_TAG_PREFIX=
INCUDAL_AGENT_RELEASE_TOKEN=
```

預設來源 `XiaoLong-Taiwan/XPayincus`。Agent repository 非空時優先；官方統一來源或與統一設定相同的來源預設 `v*`，其他 Agent 專用來源預設 `agent-v*`。prefix 明確空值使用 `v*`，`agent-` 使用舊格式。Compose 已傳入兩個 repository 設定，prefix／token 等需額外注入 API 容器。

代理優先讀版本化 Agent manifest，沒有才用 `manifest.json`，驗證雙架構檔名、版本、大小與 SHA256；只有缺少 manifest 才回退雙架構未壓縮 binary，無效 manifest 不回退。GitHub 403／429 不立即重試或改匿名；只有完整驗證快取可作網路失敗回退，畫面須顯示實際快取版本，不能當作最新版本。無快取則失敗。

無遠端 Release 時可設 `INCUDAL_AGENT_RELEASE_DIR=/opt/incudal/agent-release`，放完整舊格式 `manifest.json` 與兩架構 `.gz`，manifest 的 SHA256 對應壓縮位元組。原始碼 zip、tag 或 Actions artifacts 不能代替 installer 所需的 Release 資產。

從統一倉庫根執行 `bash scripts/build-agent-release.sh`，讀取根版本並輸出 Agent binary／`.gz`／manifest。正式發布入口為根 `.github/workflows/release.yml`；手動流程 artifacts 不等於正式 GitHub Release，發布及 Linux 真機驗收須另有證據。
