# XPayincus Host Agent

## 最簡安裝指令

先在 Dashboard 建立宿主並取得該主機的一次性 TOKEN；於目標 Incus 宿主以 root 執行以下指令，輸入面板 HTTPS origin（例如 `https://panel.example.org`）與 TOKEN，核對資訊後確認：

```bash
( f=$(mktemp) && trap 'rm -f "$f"' EXIT && curl -q -fsSL --proto '=https' --proto-redir '=https' https://raw.githubusercontent.com/XiaoLong-Taiwan/XPayincus/main/scripts/agent-menu.sh -o "$f" && bash -n "$f" && bash "$f" --action install )
```

此互動入口會從輸入的面板下載安裝器，也可使用面板產生的主機專用安裝指令。TOKEN 僅在互動提示輸入，不要放入 URL、命令列或公開日誌。需先完成 Dashboard 部署；新裝 Agent 會準備 Incus／ZFS，並依 bootstrap 安裝 Caddy。`main` 入口可能領先正式 Release。詳見[面板部署](../XPayincus/README.md#最簡部署指令)及[宿主安裝指南](../XPayincus/docs-site/docs/agent/install.md)。

Go Agent 部署在 Incus 宿主機，負責資源、實例狀態、流量與監控歷史回報，透過 HMAC-SHA256 認證連線面板，並建立出站 WSS 管理隧道。Agent、Incus、Caddy、RFW 與 ZFS 均在宿主執行，不放進面板 Compose。

本文依目前來源樹實作整理；根 [VERSION](../VERSION) 的 `v1.0.26` 是發行目標，正式可下載版本與功能以實際 GitHub Release、面板提供的安裝器及已部署的 Server／Agent 為準。`main` 腳本可能領先穩定版，不能據此推定功能已發布。新的隧道 frame 要求 Server／Agent 協調更新，沒有舊版能力協商或直連降級。操作指南另見 [Agent 安裝](../XPayincus/docs-site/docs/agent/install.md)。

## 元件分工與需求

| 元件 | 責任與邊界 |
| --- | --- |
| Go Agent | 心跳、採樣、歷史 spool、經授權的自身 binary 升級；轉送管理請求到固定本機 Incus socket／Caddy admin API。 |
| Incus | 容器／虛擬機生命週期、映像、網路、儲存池及實例 API。Agent 需有本機 socket 權限，安裝 unit 以 root 執行。 |
| ZFS | 宿主核心模組、pool／dataset 與快照儲存；新裝預設使用 ZFS，既有池沿用、不自動轉換 driver。 |
| Caddy | 宿主網站反向代理及憑證服務；Agent 只連本機原生 admin API `127.0.0.1:2019`。新裝依 bootstrap 提供的同源 URL 安裝 Caddy。 |
| RFW | 獨立 Rust/eBPF/XDP 防火牆工具；Go Agent 不自動啟停 RFW、不下載或載入 eBPF，也不執行 DKMS／`modprobe`。 |

[RFW／ZFS 宿主元件](components/README.md) 位於 `components/rfw`、`components/zfs`，保留獨立工具鏈與資產名稱。bundle 是統一 Release 的邏輯元件集合，不代表 Agent 自升級會安裝全部元件。

- 安裝器支援 Linux `amd64`（x86_64）／`arm64`（aarch64），宿主準備腳本限定 Ubuntu／Debian。建議 Ubuntu 22.04+、Debian 12／13；Debian 11 保留相容能力，Debian 10 以下拒絕。其他 Linux 即使能編譯 Go Agent，也不等於整套安裝流程受支援。
- 使用 root、Bash、運作中的 systemd、curl、CA 憑證、SHA256 工具；下載 `.gz` 需 gzip。manifest／版本驗證需 python3；目前首次 `ait_` 安裝缺少 python3 時會透過 apt-get 準備，重裝缺少時會停止。選單可用 wget 下載模板，但 installer 仍需要 curl。
- Incus 所需核心功能、ZFS 工具／模組與 `/dev/zfs` 必須可用；虛擬機另需可用的硬體虛擬化／KVM。受限容器或不允許載入核心模組的 VPS 不能當作完整宿主保證。
- **小型部署建議起點，未做容量壓測**：宿主 2 核、4 GiB RAM、40 GiB 系統碟，另預留容器／映像／快照／備份空間。實際需求依實例數、負載、ZFS ARC、磁碟 I/O 與保留政策估算。unit 的 `MemoryMax=256M` 是 Agent 程序上限，不是宿主最低 RAM；ARC 限制也不是 ZFS 總記憶體硬上限。

## 網路與協定

正式部署使用可驗證憑證的 HTTPS 面板 origin，例如 `https://panel.example.org:8443`，不能帶帳密、路徑或 query。Agent 對該 origin 呼叫 `POST /api/agent/heartbeat`，並主動連線 **`wss://panel.example.org:8443/api/agent/tunnel`**，子協定 `xpayincus-tunnel-v1`。隧道要求 HTTPS；安裝輸入接受 HTTP 不代表 WSS 管理可用。

宿主需能解析面板 DNS、連出面板 HTTPS／WSS，安裝時還需連到套件來源；面板端需能取得 Release，或有完整可信本地資產。反向代理／WAF 必須允許 WebSocket Upgrade、長連線及 Agent 的 HMAC headers，避免把 API 改寫成登入頁。正常管理不要求面板直連宿主 Incus 8443 或 Caddy 2019；實例 SSH、NAT 映射與網站對外埠依服務需求另行開放。

隧道握手以 GET、固定路徑及空 body SHA256 簽名，使用 `x-incudal-agent-id`、`x-incudal-timestamp`、`x-incudal-nonce`、`x-incudal-body-sha256`、`x-incudal-signature`；timestamp／nonce 會驗證，需同步宿主與面板時間。拒絕 Origin header，每個 host 一條隧道；停用或輪換憑證會使連線失效。後端連線 registry 為程序內狀態，只支援單一 Node 程序。

固定轉送目的地為 `/var/lib/incus/unix.socket` 的 `/1.0` API 與 `127.0.0.1:2019` 的 `/config/...`、`/id/...`。不接受任意代理 URL、宿主 shell frame 或 redirect；原遠端 Caddy TLS／Basic Auth 不會轉送至本機 API。Incus 本身仍具實例 exec 等管理能力。一般 body 上限 512 KiB，串流每塊 64 KiB、每 host 最多 8 個工作；有界 HTTP 串流、終端 ACK、重連與未知結果語意見 [TUNNEL.md](TUNNEL.md)。斷線不重播寫入，timeout 後應查 operation／資源狀態再決定下一步。

IPv4 NAT 與 IPv6 routed 是不同配置。IPv6 需供應商真正路由到宿主的可用前綴、正確轉送與防火牆；只有一個宿主 IPv6 地址不等於有可分配的 `/64`。Agent 只有回報明確 routed 能力及合法前綴，面板才會據此啟用 routed 模式；舊 IPv6 NAT 值僅留作歷史相容。純 IPv6 宿主仍須能到達面板、套件來源與下載來源；宿主腳本的 WARP 準備可能失敗，不能保證補足 IPv4 出站。

## 首次名稱 onboarding 與安裝

目前來源樹的新節點流程只要求名稱：管理員填完整名稱，一般使用者填 `PEER<使用者ID>-` 後綴；完整名稱長度 2–64，只使用英數、底線、連字號。建立後取得分開顯示的面板 endpoint 與一次性 TOKEN，首次不要求公開宿主 IP／Incus API 埠。舊部署畫面若不同，先核對面板版本。

確認 endpoint 是這台宿主要加入的可信面板，TOKEN 對應正確節點，再下載並執行安裝器。`ait_` TOKEN 有效 30 分鐘、只能兌換一次；重新產生會輪換 Agent 憑證，使舊憑證失效。相容的 UUID 宿主 TOKEN 走宿主初始化再安裝 Agent，與 `ait_` 流程不同。

以下為 **Linux root shell** 指令（需要時先 `sudo -i`）。以私人暫存目錄下載完整檔案，下載成功才執行；結束清除暫存。不要將 TOKEN 寫入 URL、命令列或 shell 歷史。

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

依提示分開輸入 endpoint 與隱藏 TOKEN，核對摘要中的面板、版本及儲存計畫，再確認開始。`--yes` 只略過確認，不補齊缺少輸入。無 TTY 自動化使用 `--panel-url https://panel.example.org --token-file /root/agent-install.token --yes`；TOKEN 檔案必須是目前執行者擁有、權限 0600 的一般檔案，不可是 symlink，執行後由管理者移除。不提供明文 `--token`；仍相容 `INCUDAL_PANEL_URL`／`INCUDAL_AGENT_INSTALL_TOKEN` 環境變數。

目前 `ait_` 新裝先預檢、依 manifest 下載並驗證 binary，再呼叫宿主 `--prepare-agent-host` 準備 Incus／ZFS，之後兌換 TOKEN。預設新池為 ZFS loop、10 GiB；這不是生產容量建議，可事先設定 `INCUS_STORAGE_SIZE=40GiB` 等適當容量。可用 `INCUS_STORAGE_POOL` 選既有池、`INCUS_STORAGE_DRIVER=zfs|dir|auto` 控制新池；已有 default profile root 時沿用其 pool，不更換 root，也不接受任意磁碟／source 參數。

TOKEN 以 `/api/agent/install-config/:token?bootstrap=1` 兌換，目前嚴格解析五行：Agent ID、secret、base64 面板憑證、宿主安裝狀態、同源 Caddy installer URL；不執行回應程式碼。憑證配對檢查失敗會回 503 且不消耗 TOKEN；舊兩／四行回應須更新面板。兌換 URL 不跟隨轉址，代理存取日誌應遮蔽 TOKEN 路徑。

後續安裝 Caddy 與宿主捷徑、必要時匯入首次 Incus trust，使用暫存設定跑 `-once` 冒煙後才原子替換 binary、設定與 unit。服務啟動後再檢查；失敗會嘗試回復原 Agent 檔案及服務狀態，**不會回復先前的宿主初始化、Caddy 安裝或面板憑證輪換**。首次顯示「待驗證」時，回面板確認 Agent 在線及管理功能；目前新建頁驗證看 Agent 心跳，不直連宿主 API。依畫面完成驗證後，必要時執行 `incudal --refresh-agent-trust`，不要提前移除舊 trust。

## 管理選單、更新與同版修復

根 `scripts/agent-menu.sh` 提供 install、reinstall、update、local、status、logs 六個動作，可由統一管理入口呼叫或獨立執行。選單從指定面板取得 `/api/agent/install.sh`，實際宿主準備由 installer 執行。使用已審閱且與面板相容的版本；以下 **main 是來源樹入口，可能含尚未發布能力**，若要固定版本，改用已確認含此腳本的 Release tag／commit。

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

以下假設已將審閱過的腳本保存在 `/root/agent-menu.sh` 與 `/root/agent-install.sh`：

```bash
bash /root/agent-menu.sh --action status
bash /root/agent-menu.sh --action logs
bash /root/agent-menu.sh --action update --version latest
bash /root/agent-menu.sh --action reinstall --version v1.0.26
bash /root/agent-menu.sh --action local --binary /root/build/incudal-agent \
  --sha256 '<可信的64位SHA256>'
bash /root/agent-install.sh --reinstall --binary /root/build/incudal-agent --sha256 '<可信的64位SHA256>'
```

版本號僅為用法範例，須已存在可用 Release。`update` 與 `reinstall` 都走 installer `--reinstall`：保留原設定／憑證，重新下載、驗證、覆寫 binary 與 unit 並重啟。**同版也會重新安裝，可用來強制修復同版檔案或套用新 unit，不需要也沒有 `--force`。** 重裝不接受新 endpoint／TOKEN，不準備 Incus／ZFS、不重做 bootstrap，無既有設定不能使用。`status` 是 systemd 狀態；`logs` 顯示最近 100 行，不是持續追蹤。

目前來源樹的選單已支援 `--action local --binary FILE --sha256 HASH`，並將雜湊傳給 installer；選單的 `--sha256` 僅適用 `local`，HASH 必須是可信來源的 64 位十六進位 SHA256。舊選單腳本需更新後才能使用此參數。本機檔案需是已編譯、未壓縮、符合宿主 Linux 架構的 binary；不下載 manifest／binary，也不編譯，仍需連面板做心跳冒煙。未指定可信雜湊時，自行計算的 SHA256 只驗證複製一致性，不證明來源可信。本機模式不提供遠端 manifest 的版本防降級保護，管理者需自行核對。

`reinstall`／安裝器 `--reinstall` 未指定 `--version` 時仍選擇 `latest`，可能升版，不會自動固定目前版本。同版修復必須先確認已安裝版本，再以 `--version` 指定該版本。

遠端安裝依 canonical SemVer 檢查既有 `-version`、目標版本及 `minimumUpdaterVersion`；拒絕降版，若舊 binary 不支援版本辨識，需先核對可信本機 binary 再修復。顯式 `--version` 固定版本 manifest 與 SHA256。使用快取會顯示實際版本及「無法確認最新」，不能當成已取得最新穩定版。

## 設定、路徑與保留範圍

| 項目 | 預設絕對路徑 |
| --- | --- |
| Agent binary／自升級備份 | `/usr/local/bin/incudal-agent`／`/usr/local/bin/incudal-agent.bak` |
| 設定（root:root、0600） | `/etc/incudal-agent/config.yaml` |
| systemd unit／日誌 | `/etc/systemd/system/incudal-agent.service`／`journalctl -u incudal-agent` |
| 私人 state（0700） | `/var/lib/incudal-agent` |
| 舊歷史／v2 監控 spool | `/var/lib/incudal-agent/history`／`/var/lib/incudal-agent/monitoring-v2` |
| 升級狀態／鎖 | `/var/lib/incudal-agent/upgrade.json`／`/run/incudal-agent-upgrade.lock` |
| 本機管理 API | `/var/lib/incus/unix.socket`／`http://127.0.0.1:2019` |
| 宿主捷徑 | `/usr/local/bin/incudal`、`/usr/local/bin/k` |
| 元件狀態來源 | `/run/xpayincus/rfw-status.json`、`/run/xpayincus/zfs-status.json` |
| ZFS ARC 設定 | `/etc/modprobe.d/99-zfs-arc.conf` |

目前來源樹的選單與 installer 都優先使用 `INCUDAL_CONFIG_FILE` 指定的設定檔，其次使用 `${INCUDAL_CONFIG_DIR}/config.yaml`，皆未指定時預設為 `/etc/incudal-agent/config.yaml`。舊選單與 installer 腳本需更新，以確保使用相同的設定路徑優先順序。binary／unit 可用 `INCUDAL_INSTALL_DIR`、`INCUDAL_AGENT_BIN`、`INCUDAL_SERVICE_FILE` 覆寫。宿主信任工具則使用 `INCUDAL_AGENT_CONFIG_FILE`，不要混淆。自訂路徑需讓 unit、選單與信任工具使用同一檔案。重裝擷取 endpoint 依安裝器產生的 `panel_url: "…"` 單行格式，任意 YAML 排版不保證相容。

```yaml
panel_url: "https://panel.example.org"
agent_id: "<面板產生的 Agent ID>"
agent_secret: "<面板產生的私密金鑰>"
heartbeat_interval_seconds: 60
request_timeout_seconds: 10
state_dir: "/var/lib/incudal-agent"
spool_max_bytes: 16777216
spool_retention_hours: 72
```

執行期支援 `INCUDAL_PANEL_URL`、`INCUDAL_AGENT_ID`、`INCUDAL_AGENT_SECRET`、`INCUDAL_HEARTBEAT_INTERVAL_SECONDS`、`INCUDAL_REQUEST_TIMEOUT_SECONDS`、`INCUDAL_AGENT_STATE_DIR`、`INCUDAL_AGENT_SPOOL_MAX_BYTES`、`INCUDAL_AGENT_SPOOL_RETENTION_HOURS` 覆寫。設定為簡單 `key: value`，不是完整 YAML 引擎。請持久保留私人 state，勿分享設定內容或備份中的 secret。

預設心跳 60 秒、允許 30–3600 秒；單次最多 500 個實例，狀態讀取並發 3，非執行中不額外讀 `/state`。成功日誌首筆及約每 10 分鐘一次，失敗首筆及約每分鐘一次。unit 限制 `CPUQuota=20%`、`MemoryMax=256M`、`TasksMax=128`、journal 每 30 秒最多 120 筆。binary 自升級不改 unit；保留設定重裝才會套用當前模板限制。

## 面板授權自升級

面板在 Agent 在線、啟用、版本可辨識且有較新相容版本時，允許擁有者／管理員明確確認升級。`POST /api/agent/hosts/:hostId/upgrade` 使用 `{ "confirm": true, "targetVersion": "v1.0.26" }`（版本為範例）；Server 重新驗證版本、平台及最低 updater，固定 manifest 版本／雜湊／同源 URL。未授權心跳不自動推新版，同版自升級不替換檔案；同版修復請用 installer 重裝。

Agent 最多隨機等待 5 分鐘，執行逾時 10 分鐘；只接受 `panel_url` 同源 URL 與轉址，下載／解壓上限各 64 MiB，先檢查 SHA256／大小再解壓、備份、原子替換並安排服務重啟。此流程只更換 Agent binary，不更新 unit、Incus、Caddy、RFW 或 ZFS。不要把 `.bak` 的存在視為健康失敗後一定自動回復的保證。

目前支援 `upgrade-status-v1` 的實作以 operation ID 去重，記錄 downloading、verifying、replacing、awaiting-health 等階段，重啟後成功資源心跳確認 healthy；舊 Agent 維持一次下發相容行為。Server 狀態含 pending、delivered、succeeded、failed、unconfirmed，等待視窗為兩次心跳加 20 分鐘；HTTP 成功／已下發不代表升級成功。已部署版本是否提供細分狀態，需核對 Release。

API 的授權 journal 需使用倉庫外私人可寫絕對目錄 `INCUDAL_AGENT_STATE_DIR`，預設服務帳號 `~/.local/state/xpayincus/agent`；此為面板端設定，與宿主 Agent 的同名環境變數分屬不同程序。Compose 需持久掛載，檔案 journal 不提供跨程序鎖，禁止多 API 副本。重啟 API 不取消已下發工作，憑證輪換後不沿用舊授權，稽核事件為 `host.agent_upgrade_request`。

## 監控與除錯

監控 schemaVersion 2 包含宿主／實例歷史、Linux PSI、累計計數器差值／重設辨識、RFW／ZFS 狀態事件與 avg／min／max／count／coverage。缺少指標不補零，重啟、計數器重設與採樣間隔會影響 coverage。預設 spool 各受設定的 16 MiB／72 小時限制；伺服器最多保留 30 天，樣本 8192 筆或 1536 KiB、元件事件 512 筆或 256 KiB，達上限會提早截斷，不能保證完整 30 天。監控歷史不取代計費紀錄或備份。

在宿主先做唯讀檢查：

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

- **403／認證失敗**：分辨是面板 HMAC、TOKEN 兌換、WAF，還是面板連 GitHub 被拒絕。核對節點啟用狀態、endpoint、是否重新簽發 TOKEN 導致舊 secret 失效、代理是否保留 headers，以及宿主／面板 UTC 時間。不要關閉驗證或盲目反覆兌換。
- **DNS／TLS／時間偏差**：檢查 A／AAAA、IPv4／IPv6 實際出站、完整 CA chain、憑證主機名與期限、系統時間及 NTP。不要使用 `-k` 略過 TLS。心跳正常而操作失敗時，再看 WSS Upgrade／長連線、Server／Agent 協定相容性及本機 API。
- **ZFS／pool 失敗**：核對 `uname -r`、`modinfo zfs`、`/dev/zfs`、核心 headers／DKMS 或預編譯模組相容性、磁碟可用空間與 `zpool status`。Agent 重裝不修核心模組；新裝明確要求 ZFS 時不可把失敗當成已自動降級 dir。現有 root 指向無效 pool 時需先修復，不刪池重建。
- **監控空白／缺口**：核對 Incus socket、`/proc/pressure/`、state 所有者／權限／磁碟空間及 spool 是否收到 ACK；元件狀態檔須是有效一般 JSON 檔且約 5 分鐘內更新。缺少 exporter 或 stale 檔案代表 unavailable，不等於 RFW／ZFS 故障，也不應填零。
- **舊安裝下載 400／manifest 解析失敗**：舊 installer 可能將 timestamp 放進保留的 `v` 參數，或不能解析單行 manifest。更新面板安裝器，確認使用獨立 `cache_bust` 與固定版本 `v`／SHA256，再取新命令。
- **TOKEN 與重試**：binary 下載／校驗在兌換前，失敗可在有效期內修正重跑；TOKEN 交換只發一次，回應遺失、消耗狀態不明、格式錯誤或後續失敗時先查原因，再產生新 TOKEN。新憑證輪換不能由本機備份撤銷。保留設定重裝可修正後重跑。

首次 Incus trust 匯入不代表完整管理驗收；`incudal --refresh-agent-trust` 依既有 HMAC 認證取得並驗證面板憑證，確認新連線成功後才移除舊指紋。不要因舊腳本提示需要直連 8443 就公開管理埠，先核對是否混用舊版直連腳本。若 `AGENT_AUTH_REQUIRED`／`AGENT_SIGNATURE_INVALID`，重新配對而非跳過檢查。面板 `client.crt`／`client.key` 必須成對還原，半套或配對不符時不可刪檔觸發重建。

## Release 來源、相容與建置

以下只放面板後端，私有 GitHub token 不下發宿主：

```dotenv
INCUDAL_RELEASE_REPOSITORY=owner/unified-repository
INCUDAL_AGENT_RELEASE_REPOSITORY=
INCUDAL_AGENT_RELEASE_TAG_PREFIX=
```

未設定時使用 `XiaoLong-Taiwan/XPayincus`。Agent repository 非空時優先；官方統一來源或與統一設定相同者使用 `v*`，其他 Agent 專用來源預設 `agent-v*`，可用 tag prefix 明確覆寫（空值為 `v*`、`agent-` 為舊格式）。私有來源另設 `INCUDAL_AGENT_RELEASE_TOKEN`。Compose 已傳入兩個 repository 變數，prefix／token 等需額外注入 API 容器。

代理優先讀版本化 Agent manifest，缺少才用 `manifest.json`，核對雙架構檔名、大小及 SHA256；只有 manifest 缺失才允許回退兩架構未壓縮 `xpayincus-agent-${VERSION}-linux-{amd64,arm64}`，無效 manifest 不回退。也可設 `INCUDAL_AGENT_RELEASE_DIR=/opt/incudal/agent-release`，放完整舊格式 `manifest.json` 與兩架構 `.gz`，其雜湊對應壓縮位元組。tag、原始碼 zip 或 Actions artifacts 不等於可供 installer 使用的 Release 資產。

GitHub 403／429 不立即重試或移除憑證改匿名；可回退完整驗證的持久快取，無快取則失敗。無效 schema／版本／大小／SHA256 不以快取繞過。installer 的公開下載使用 10 秒連線、120 秒單次逾時、暫時性錯誤最多補試 2 次；TOKEN 交換總逾時 30 秒且不自動重送。

從統一倉庫根建置：

```bash
bash scripts/build-agent-release.sh
```

wrapper 讀根版本，呼叫本目錄 `scripts/build-release.sh`，輸出未壓縮 binary、`.gz` 與相容 manifest。本目錄 `go.mod` 宣告 Go 1.19；開發請使用與 CI 相容的工具鏈。可在本目錄執行 `go test ./...`，或 `go run ./cmd/incudal-agent -config /etc/incudal-agent/config.yaml -once`；`-once` 只執行一次心跳，不啟動常駐隧道或自動升級。

統一發布入口為根 `.github/workflows/release.yml`，手動流程的 artifacts 不代表正式 Release；相符 tag 流程成功發布後才可按 Release 驗證。RFW 由 `scripts/build-rfw-release.sh` 建置，ZFS 由 `scripts/package-zfs-source.sh` 封裝 source-only 包，兩者不進入 Agent 舊 manifest 或面板 OTA manifest。發行規則見 [RELEASE.md](../RELEASE.md)。
