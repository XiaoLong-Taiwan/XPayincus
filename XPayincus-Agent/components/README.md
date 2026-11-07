# Agent 宿主元件管理

本目錄以宿主元件 bundle 的方式組織 RFW 與 ZFS builder。bundle 是同一統一 Release 下的邏輯交付集合，沿用現有獨立資產，不新增 bundle tarball、不改變既有 26 件發行資產契約，也不代表自動安裝或共同原子升級。

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
| ZFS builder 原始碼 | `xpayincus-zfs-builder-${VERSION}-source.tar.gz`，包內仍為 `VERSION`、`README.md`、`zfs-builder.sh` |
| 完整性與索引 | `release-manifest.json`、個別 `.sha256` 與 `SHA256SUMS` |

根 release workflow 分別建置 Agent 與 RFW，彙整階段封裝 ZFS source；沒有將 RFW 或 ZFS 加入 Agent gzip、Agent manifest 或面板 OTA manifest。`release-manifest.json` 的 ZFS 狀態仍為 `source-only` 且 `kernelModulesBuilt: false`。產品版本與實際 ZFS 模組版本不同；後者由 Debian 套件／DKMS 來源決定。

根 `scripts/release-contract.mjs` 在所有共用發行入口檢查新實體目錄、拒絕舊頂層目錄殘留，並從新路徑檢查 ZFS `VERSION` 及 RFW 三個 crate 的版本。元件內相對 Cargo 路徑及鎖檔維持不變。根 `.github/workflows` 是唯一有效入口；搬入的元件 `.github/workflows` 只保留歷史參考，不應直接複製啟用。

## 安裝與日常管理

- Agent：使用面板產生的安裝命令及原有 systemd 服務；自升級只替換 Agent 二進位，不改 RFW 規則或 ZFS 模組。
- RFW：先核對 Release 來源、架構與 SHA256，保留管理主控台，再按 [RFW 文件](rfw/README.md) 選擇介面、規則與 XDP 模式。使用獨立程序／服務管理，不把 RFW 啟停綁到 Agent 心跳或重啟。
- ZFS：source 包不是可載入模組。按 [ZFS 文件](zfs/README.md) 在專用 Debian 編譯機針對指定架構與完整 kernel ABI 建置，記錄實際 ZFS 版本、vermagic、SHA256 與 Secure Boot 簽章需求，再由管理者於維護窗口驗證。
- 歷史來源：既有宿主安裝器釘選的 RFW／ZFS URL、版本與雜湊不是本機來源路徑，不因搬移而替換；切換下載來源仍須另行核驗及授權。

## 升級與回復

部署前保留目前 Agent 二進位與設定、RFW 二進位／啟動參數／規則，以及 ZFS 模組與可用核心記錄；金鑰、設定及備份不可提交倉庫。核對可信 Release 的 SHA256 與完整資產集合，不將同來源下載的雜湊當作來源真偽的唯一保證。

分別排定三個元件的變更與驗收。Agent 可沿用原有備份與原子替換流程；RFW 更新前先確認管理通道及介面附加狀態，正常停止後再替換，異常退出須人工檢查 XDP 是否仍附加；ZFS 不在使用中的儲存池上嘗試強制卸載或即時替換模組，需備份與維護／重啟方案，回復至已驗證的核心／模組組合。不可將 Agent 自升級成功當作防火牆或儲存元件驗收成功。

## 驗證邊界

本次不執行本機測試、建置、封裝、核心載入或宿主安裝。根 CI 配置版本／來源目錄守衛、元件 shell 語法檢查與 ZFS source 封裝；Release 工作流負責原有雙架構二進位與資產集合檢查。是否通過須另查對應 commit 的 Actions 紀錄，核心與網卡相容性、儲存安全及回復能力仍需經授權的隔離環境與目標主機驗收。詳見 [統一發行](../../RELEASE.md)。
