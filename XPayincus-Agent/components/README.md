# Agent 宿主元件管理

本目錄以宿主元件 bundle 的方式組織 RFW 與 ZFS builder。bundle 是同一統一 Release 下的邏輯交付集合，沿用現有獨立資產，不新增 bundle tarball、不改變既有 30 件發行資產契約，也不代表自動安裝或共同原子升級。

## 來源與責任

| 元件 | 倉庫根相對來源 | 執行／載入責任 |
| --- | --- | --- |
| Go Agent | `XPayincus-Agent/cmd`、`XPayincus-Agent/internal` | 心跳、只讀監控與自身二進位升級 |
| RFW | `XPayincus-Agent/components/rfw` | 獨立 Rust 使用者空間程序管理 eBPF/XDP |
| ZFS builder | `XPayincus-Agent/components/zfs` | 管理者在專用 Debian 編譯機執行 DKMS 建置；模組由宿主管理流程載入 |

Go Agent 不 import、embed 或透過 cgo 載入上述核心功能，也不執行 RFW、DKMS 或 `modprobe`。元件搬移只改變來源樹與建置入口，不新增遠端命令、特權委派或服務控制介面。三者均不在面板 Compose 內執行。

## Bundle 交付契約

以根 `VERSION` 定義產品版本；不從目錄名稱、GitHub tag 或環境變數推定另一版本。從統一倉庫根目錄執行的參考命令如下，本次未執行：

```bash
bash scripts/build-agent-release.sh
bash scripts/build-rfw-release.sh
bash scripts/package-zfs-source.sh
```

| 交付內容 | 保留的 Release 資產名稱 |
| --- | --- |
| Agent amd64／arm64 | `xpayincus-agent-${VERSION}-linux-{amd64,arm64}` 及各自 `.gz` |
| Agent 下載契約 | `manifest.json`，只列兩架構 Agent `.gz` |
| RFW amd64／arm64 | `xpayincus-rfw-${VERSION}-linux-{amd64,arm64}` |
| ZFS builder 原始碼與宿主管理工具 | `xpayincus-zfs-builder-${VERSION}-source.tar.gz`，保留原根檔案，加入 Debian CI builder／verifier、ZFS status 與 `host-tools/` |
| 完整性與索引 | `release-manifest.json`、個別 `.sha256` 與 `SHA256SUMS` |

根 release workflow 分別建置 Agent 與 RFW，彙整階段封裝 ZFS source；沒有將 RFW 或 ZFS 加入 Agent gzip、Agent manifest 或面板 OTA manifest。`release-manifest.json` 的 ZFS 狀態仍為 `source-only` 且 `kernelModulesBuilt: false`。產品版本與實際 ZFS 模組版本不同；後者由 Debian 套件／DKMS 來源決定。

根 `scripts/release-contract.mjs` 在所有共用發行入口檢查新實體目錄、拒絕舊頂層目錄殘留，並從新路徑檢查 ZFS `VERSION` 及 RFW 三個 crate 的版本。元件內相對 Cargo 路徑及鎖檔維持不變。根 `.github/workflows` 是唯一有效入口；搬入的元件 `.github/workflows` 只保留歷史參考，不應直接複製啟用。

## 安裝與日常管理

- Agent：使用面板產生的安裝命令及原有 systemd 服務；自升級只替換 Agent 二進位，不改 RFW 規則或 ZFS 模組。
- RFW：先核對 Release 來源、架構與 SHA256，保留管理主控台，再按 [RFW 文件](rfw/README.md) 選擇介面、規則與 XDP 模式。使用獨立程序／服務管理，不把 RFW 啟停綁到 Agent 心跳或重啟。
- ZFS：source 包不是可載入模組。按 [ZFS 文件](zfs/README.md) 在專用 Debian 編譯機針對指定架構與完整 kernel ABI 建置，記錄實際 ZFS 版本、vermagic、SHA256 與 Secure Boot 簽章需求，再由管理者於維護窗口驗證。
- 歷史來源：既有宿主安裝器釘選的 RFW／ZFS URL、版本與雜湊不是本機來源路徑，不因搬移而替換；切換下載來源仍須另行核驗及授權。

## 升級與回復

### 管理工具安裝與狀態排程

先驗證同版本 source 包 SHA256，再解壓並執行 `sudo bash host-tools/install-host-tools.sh`；從倉庫使用時則執行 `sudo bash XPayincus-Agent/components/install-host-tools.sh`。需要 Linux、Python 3、執行中的 systemd；安裝器交付 `/usr/local/sbin/rfw-manage`、`/usr/local/sbin/zfs-status` 及 `/usr/local/lib/xpayincus-host/` 中的獨立工具。這只安裝管理工具與唯讀收集排程，RFW 二進位須另行驗證安裝到 `/root/rfw/rfw`，ZFS 工具與匹配核心模組也須另行準備。

`xpayincus-snapshot@rfw.timer` 與 `xpayincus-snapshot@zfs.timer` 在開機約 30 秒後開始收集，各次完成後約 60 秒再執行。兩個 oneshot 服務彼此獨立，以 root 唯讀查詢宿主元件，不啟停 RFW、不載入 ZFS 或匯入 pool。這裡 snapshot 指狀態 JSON，並非 ZFS dataset snapshot。

輸出為 `/run/xpayincus/rfw-status.json` 與 `/run/xpayincus/zfs-status.json`，限制 64 KiB；同目錄暫存、檔案 fsync、原子 replace 後同步目錄。每份檔案各自原子發布，兩個元件不構成共同交易。失敗保留舊檔，Agent 超過五分鐘即視為不可用；重啟後 `/run` 重新收集，不保留為歷史資料。RFW status 包含實際 XDP program ID 比對，沒有 generation 或舊二進位不支援 status 時收集失敗；可用 `journalctl -u xpayincus-snapshot@rfw.service` 查看原因。

停用排程使用 `sudo systemctl disable --now xpayincus-snapshot@rfw.timer xpayincus-snapshot@zfs.timer`；既有檔案會依時效失效。工具安裝不替換防火牆服務或核心模組，亦沒有跨工具版本的共同原子升級。

### Agent 持久 state

Agent 安裝模板在新設定加入 `state_dir: "/var/lib/incudal-agent"`、16 MiB spool 上限與 72 小時保留期。systemd 使用 `StateDirectory=incudal-agent`、0700 與 `UMask=0077`，保存 `history/` 及 `upgrade.json`，服務重啟或二進位更新不刪除 state。此目錄含待補送歷史及升級狀態，應以私人資料管理，不可提交倉庫。

`--reinstall` 保留原設定；沒有 state_dir 的舊設定沿用 Agent 預設目錄。若已自訂 state_dir 或 `INCUDAL_AGENT_STATE_DIR`，管理者須自行確保該絕對路徑的擁有者、0700 權限與持久磁碟，`StateDirectory` 僅管理標準目錄。State 不移到 `/run`，也不與元件狀態 JSON 混用。

部署前保留目前 Agent 二進位與設定、RFW 二進位／啟動參數／規則，以及 ZFS 模組與可用核心記錄；金鑰、設定及備份不可提交倉庫。核對可信 Release 的 SHA256 與完整資產集合，不將同來源下載的雜湊當作來源真偽的唯一保證。

分別排定三個元件的變更與驗收。Agent 可沿用原有備份與原子替換流程；RFW 更新前先確認管理通道及介面附加狀態，正常停止後再替換，異常退出須人工檢查 XDP 是否仍附加；ZFS 不在使用中的儲存池上嘗試強制卸載或即時替換模組，需備份與維護／重啟方案，回復至已驗證的核心／模組組合。不可將 Agent 自升級成功當作防火牆或儲存元件驗收成功。

## 驗證邊界

本次不執行本機驗證、測試、建置、封裝、核心載入或宿主安裝，也不提交。根 CI 配置版本／來源目錄守衛、operations 測試、原子狀態輸出測試、元件 shell 語法檢查與 ZFS source 封裝；Release 工作流負責原有雙架構二進位與資產集合檢查。是否通過須另查對應 commit 的 Actions 紀錄，核心與網卡相容性、儲存安全及回復能力仍需經授權的隔離環境與目標主機驗收。詳見 [統一發行](../../RELEASE.md)。
