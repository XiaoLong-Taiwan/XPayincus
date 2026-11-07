# XPayincus ZFS Builder

統一倉庫的 Debian 宿主 ZFS 預編譯模組打包工具。`zfs-builder.sh` 在專用 Debian 編譯主機安裝建置相依與 DKMS，針對指定核心建置並封裝模組；不部署於面板 Compose。

產品發行版本由 [根 VERSION](../VERSION) 管理，目前為 `v1.0.0`，本目錄 `VERSION` 為產品版本記錄。實際 ZFS 模組版本仍由 Debian 套件與 DKMS 來源決定，不能改成產品版本號。

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

## 統一發行

從統一倉庫根目錄執行的 `bash scripts/package-zfs-source.sh`，以及根 release workflow，只封裝 `xpayincus-zfs-builder-${VERSION}-source.tar.gz` 原始碼包，不產生核心模組。統一 manifest 明示 `kernelModulesBuilt: false`。

宿主安裝器仍可能使用歷史獨立來源的匹配核心資產或 DKMS 回退；builder 原始碼不能代替這些模組。根 workflow 僅上傳 Actions artifacts，不會建立 GitHub Release 或部署。詳見 [RELEASE.md](../RELEASE.md)。本次文件整理未建置模組、計算實際產物雜湊或驗證主機載入。
