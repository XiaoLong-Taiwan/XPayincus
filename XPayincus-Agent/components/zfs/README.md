# XPayincus ZFS Builder

統一倉庫的 Debian 宿主 ZFS 預編譯模組打包工具。`zfs-builder.sh` 在專用 Debian 編譯主機安裝建置相依與 DKMS，針對指定核心建置並封裝模組；不部署於面板 Compose。

產品發行版本由 [根 VERSION](../../../VERSION) 管理，本次發行目標為 `v1.0.18`（發布狀態以 GitHub Release 為準），本目錄 `VERSION` 為產品版本記錄。實際 ZFS 模組版本仍由 Debian 套件與 DKMS 來源決定，不能改成產品版本號。此目錄納入 Agent 宿主元件管理，不代表 Go Agent 編譯、安裝或載入 ZFS 核心模組；管理邊界見 [元件管理](../README.md)。

## 使用方式

以下為參考指令，本次未執行。需 root 權限、Debian、可用 apt 套件來源及目標核心的 matching headers。在本目錄執行：

```bash
sudo bash zfs-builder.sh
sudo bash zfs-builder.sh --kernel <完整核心版本>
```

腳本支援互動選單及 `--all` 等模式，仍可能要求確認；會修改編譯機的套件及 DKMS 狀態，不應直接在面板或既有業務主機測試。輸出到執行時工作目錄下的 `output/`：

```text
xpayincus-zfs-<實際 ZFS 版本>-linux-<架構>-<核心版本>.tar.gz
```

每份模組只適用於對應發行版、架構及 kernel ABI。交付前需記錄實際 ZFS 版本、核心、architecture、vermagic 與 SHA256，並在目標核心驗證載入；Secure Boot 可能需要模組簽章。

## Debian 13 獨立 Actions 建置

根 [zfs-debian13.yml](../../../.github/workflows/zfs-debian13.yml) 提供獨立 `workflow_dispatch`，預設核心為 `6.12.107+deb13-cloud-amd64`，目前只允許原生 `amd64` 及 `6.12.<數字>+deb13-cloud-amd64`。輸入先透過環境變數交給 Bash allowlist 驗證，不接受任意套件、URL、shell 片段或核心 flavour。

GitHub Ubuntu runner 使用不具核心管理權限的 `debian:13-slim` 容器建置，僅掛載唯讀 builder 與獨立輸出目錄，不掛載宿主 `/lib/modules`、`/boot` 或 Docker socket。容器與 runner 共用執行中核心，但建置明確指定目標 headers，不以 `uname -r` 決定目標。不安裝核心映像、不執行 DKMS install、模組載入或重啟，也不變更 runner 核心。

CI 專用 `build-debian13-ci.sh` 不呼叫既有互動 builder。它從固定 Debian trixie／updates／security 的 main、contrib 來源安裝完整名稱的 headers，核對套件版本、`kernelrelease`、`UTS_RELEASE` 與 `Module.symvers`；找不到精確 headers 即失敗，沒有改用最新核心、近似版本或 runner headers 的回退。`zfs-dkms` 僅下載並解開來源，不安裝或執行其套件維護腳本；以 kernel-only configure/make 編譯。

所有 `.ko` 必須通過 amd64 ELF、完整 vermagic 核心字串及一致的實際模組版本驗證；缺少 `zfs.ko`、空版本、編譯或驗證錯誤均以失敗結束。所有檢查與封裝成功才寫入輸出，上傳步驟只在前面步驟成功時執行。產物包含：

- `xpayincus-zfs-<modinfo 真實版本>-linux-amd64-<完整核心>.tar.gz`，內含 `modules/*.ko`、`metadata.json` 與模組 `SHA256SUMS`。
- 同名 `.metadata.json`，記錄 Debian、kernel、architecture、ZFS 真實版本、Debian ZFS 套件版本、來源 deb SHA256、headers 套件／版本、來源 commit，以及每個模組的 version、vermagic、SHA256。
- 外層 `SHA256SUMS`，涵蓋壓縮包與獨立 metadata。

產物只保留為 14 天的獨立 Actions artifact，不進入 `dist/unified`、Release 30 件資產集合、Agent manifest、OTA 或宿主安裝器下載契約。統一 ZFS source 包保留原有根檔案，另交付 `build-debian13-ci.sh`、`verify-debian13-modules.py`、`zfs-status.py` 與 `host-tools/` 管理工具；包含建置入口不代表已建置核心模組。

實際限制：預設核心字串不代表 Debian 當前套件庫一定提供其 headers；舊版本被移除、來源不可用或 Debian ZFS 來源不支援目標核心時，建置必須失敗。本流程未提供 snapshot／自訂 headers 回退，也未釘選容器 digest 或 ZFS 套件版本，因此記錄來源版本與 SHA256，但不承諾跨日期位元組重現。模組未簽章、未實際載入，vermagic 相符仍不能取代目標主機的符號版本、Secure Boot、工具版本及儲存池相容性驗收。此工作階段僅做本機靜態／負向驗證，沒有觸發遠端 Actions 或產生真實模組。

RFW 是按 CPU 架構交付的 Rust 使用者空間程式及 eBPF/XDP 程式，不是以完整 kernel release 命名的 ZFS `.ko`。不需為 `6.12.107+deb13-cloud-amd64` 另建專用 RFW 資產；實際可用性仍取決於核心 eBPF 功能、verifier、權限、網卡驅動與 XDP 模式，見 [RFW 文件](../rfw/README.md)。

## 統一發行

`zfs-status.py`／安裝後的 `zfs-status` 唯讀收集模組版本、pool 容量與健康、裝置錯誤及 scrub／resilver 狀態。`--next-kernel <完整版本>` 明確檢查下一核心的 modinfo 與相依解析，不猜測開機目標、不載入模組；ready 不代表實際載入成功。每分鐘原子 JSON 排程由 source 包的 `host-tools/install-host-tools.sh` 安裝，詳見 [元件管理](../README.md)。排程不提供 next-kernel 參數，因此下一核心狀態預設未知。

從統一倉庫根目錄執行的 `bash scripts/package-zfs-source.sh`，以及根 release workflow，只封裝 `xpayincus-zfs-builder-${VERSION}-source.tar.gz` 原始碼包，不產生核心模組。統一 manifest 明示 `kernelModulesBuilt: false`。

宿主安裝器仍可能使用歷史獨立來源的匹配核心資產或 DKMS 回退；builder 原始碼不能代替這些模組。根 workflow 手動觸發只上傳 Actions artifacts，相符根版本的 tag 流程成功後發布統一 GitHub Release，不會部署。詳見 [RELEASE.md](../../../RELEASE.md)。本目錄 workflow 僅保留歷史參考，不作為可直接啟用的統一倉庫工作流。本次未建置模組、計算實際產物雜湊或驗證主機載入。
