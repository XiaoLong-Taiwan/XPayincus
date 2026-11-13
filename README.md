# XPayincus

統一管理 Dashboard、Server API、Agent、RFW 與 ZFS 的單一倉庫。根 [VERSION](VERSION) 是整體發行版本，`v1.0.13` 已正式發布，本次發行目標為 `v1.0.14`；正式發布狀態與最新版本以 [GitHub Releases](https://github.com/XiaoLong-Taiwan/XPayincus/releases) 為準，歷史子專案發行紀錄保留原版本，不代表目前部署版本。

本輪版本同步與驗證範圍見 [v1.0.14 發行目標](RELEASE.md#v1014-發行目標)；記錄安裝資訊分欄、TOKEN 清理與安裝流程修正，同步產品版本、Compose 標籤、fixture 與現行文件。目前為 v1.0.14 來源準備，本次僅編輯與靜態差異核對，未執行測試或建置。

| 邏輯端 | 來源目錄 | 部署方式 |
| --- | --- | --- |
| Server / Dashboard | `XPayincus/client`、`XPayincus/server` | 面板專用 Docker Compose；既有宿主部署另見面板文件 |
| Agent | `XPayincus-Agent` | Incus 宿主機二進位與 systemd |
| Agent 防火牆元件 | `XPayincus-Agent/components/rfw` | 宿主機 eBPF/XDP |
| Agent 儲存元件 | `XPayincus-Agent/components/zfs` | Debian 宿主機核心相依建置 |

前後端業務說明見 [面板 README](XPayincus/README.md)，宿主元件分別見 [Agent](XPayincus-Agent/README.md)、[RFW](XPayincus-Agent/components/rfw/README.md) 與 [ZFS](XPayincus-Agent/components/zfs/README.md)。宿主元件 bundle 與管理邊界見 [元件管理](XPayincus-Agent/components/README.md)；Go Agent 不直接載入 eBPF 或 ZFS 核心模組。pnpm workspace 位於 `XPayincus/`，不是統一倉庫根目錄。

## 統一管理入口

Dashboard 與 Agent 各有獨立入口。在 Bash／Linux 終端執行以下任一行即可開啟對應選單。Dashboard 保持啟動時的工作目錄，供 Compose 選單偵測既有部署；不依賴入口腳本位於本地檔案，因此支援 process substitution。

以下入口由官方 main 提供；部署內容以 GitHub 正式 Release 為準。curl 版本（第一行 Dashboard、第二行 Agent）：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/XiaoLong-Taiwan/XPayincus/main/scripts/dashboard.sh)
bash <(curl -fsSL https://raw.githubusercontent.com/XiaoLong-Taiwan/XPayincus/main/scripts/agent-menu.sh)
```

wget 版本：

```bash
bash <(wget --no-config --https-only -qO- https://raw.githubusercontent.com/XiaoLong-Taiwan/XPayincus/main/scripts/dashboard.sh)
bash <(wget --no-config --https-only -qO- https://raw.githubusercontent.com/XiaoLong-Taiwan/XPayincus/main/scripts/agent-menu.sh)
```

Process substitution 不會把下載程序失敗狀態自動當作 Bash 的退出碼；需要「下載成功才執行」時，可先下載至私人暫存檔：

```bash
(umask 077; t=$(mktemp -d) && trap 'rm -rf -- "$t"' EXIT && curl -q -fsSL --proto '=https' --proto-redir '=https' -o "$t/dashboard.sh" https://raw.githubusercontent.com/XiaoLong-Taiwan/XPayincus/main/scripts/dashboard.sh && bash "$t/dashboard.sh")
```

[Dashboard 入口](scripts/dashboard.sh) 下載必要的官方 raw main [Compose 子入口](XPayincus/deploy/compose/download.sh) 至私人暫存目錄，再以 Bash 執行，正常離開、失敗或收到中斷訊號時清除，不需要 git clone。選單 `[1] 安裝 Dashboard` 再選 `[1] Compose` 或 `[2] 宿主機`；宿主機選項以退出碼 20 交回 Dashboard，入口只轉交一次，不重開選單。main 是入口來源；`latest` 指 GitHub 最新正式 Release，排除 draft／prerelease，不代表 main、未發布目標或任意快取版本。Agent 沿用其安裝器的正式 Release／版本快取規則，快取不等於 latest。

完整倉庫仍可使用 `bash scripts/manage.sh`：`1` Dashboard、`2` Agent、`0` 退出；它優先讀取本地獨立入口，單檔模式才下載官方入口。子入口失敗保留非零退出狀態。

可用 `--dashboard` 或 `--agent` 直接路由，其餘參數原樣傳給子入口；Dashboard 原有 Compose CLI 保持相容：

```bash
bash scripts/manage.sh --dashboard menu /srv/incudal-panel
bash scripts/manage.sh --dashboard install /srv/incudal-panel latest
bash scripts/manage.sh --agent --action status
sudo bash scripts/dashboard.sh --host-install
sudo bash scripts/manage.sh --agent --action install --panel-url https://admin.example.org --token-file /root/agent-token
```

入口不自動 sudo；Agent 安裝／重裝／更新及 Dashboard 宿主機安裝需 root。Compose 目錄預設為啟動 cwd，由子選單確認或切換；請選擇目前帳號可寫入的目錄。無 `/dev/tty` 時須指定完整 Compose／Agent 子操作；宿主安裝固定需要終端確認。

宿主機入口僅提供 Debian 12+／Ubuntu 22.04+、amd64／arm64 的最新正式版**全新原生 Panel 安裝**，拒絕既有 `/opt/incudal`，不處理升級或卸載。輸入 `INSTALL` 確認後，解析官方 latest、下載該版本 Panel artifact 與 `.sha256`，驗證版本、SHA256、封存路徑／連結安全與必要 root helpers，再下載同 tag 的 `XPayincus/scripts/install-panel.sh`。該安裝器可單檔運作；入口僅將其產物取得函式固定到已驗證的私人暫存包，避免重新解析 latest 或使用 `/tmp/incudal` 舊快取。其餘流程沿用官方安裝器；不支援的歷史安裝器介面會拒絕。checksum 與程式均來自同一官方來源，不是獨立簽章。

**確認後會實際變更宿主服務**：安裝 Node.js 22、PostgreSQL 16、Redis、pnpm 等套件、建立帳號／資料庫、寫入 `/opt/incudal`、root helpers／sudoers／systemd、執行 migration 並啟動面板，另詢問 Nginx／Certbot 或 Cloudflare Tunnel。請先備份並排除 Compose／既有服務衝突；這不是宿主機 Incus 安裝模板。原生安裝器仍會連線套件來源，過程失敗不保證自動回滾；本次僅隔離 mock 驗證，尚未完成真機安裝驗收。

HTTPS／HTTP 下載錯誤會中止，不執行下載失敗的正文；403 可能涉及 repository／token 權限、組織 SSO、出口 IP 或代理政策，替代下載工具與正式 Release 解析都不能保證讓 403 消失。

## 面板 Docker Compose

可下載的版本化 `.sh` 與完整命令見 [Compose 下載與更新入口](XPayincus/deploy/compose/README.md#安全下載入口建議-pull-部署)：驗證入口腳本後執行 `bash xpayincus-compose-vX.Y.Z.sh install DIRECTORY VERSION SHA256`。`panel.sh setup` 初始化設定；本版宿主工具支援無參數 `bash panel.sh update`，自動固定官方最新正式 Release、取得 checksum 並驗證下載，備份 DB／部署檔後自動 up。有官方 release 檔時，預設 `up` 核對部署釘選版本的 registry digest 與本機 RepoDigests，相同時略過應用映像 pull；沒有該檔時依既有 Compose image 拉取，官方部署檔換版使用 `update`。舊手動部署經官方檔案、容器專案與原路徑掛載核對後可安全納管；任何自訂衝突即拒絕，保留私人資料及 `incudal-panel` 識別。原 `panel.sh update VERSION SHA256` 仍只準備 bootstrap 部署檔，需另行備份與 up。需對應工具、Release 與映像已正式交付；本機修改不代表線上已可用，不提供 DB 自動回滾。

在 Linux、Docker Engine 與 Compose v2.20.0 以上環境，先準備兩個獨立 HTTPS origin、DNS 及 TLS 憑證，再從統一倉庫根目錄執行（預設 Nginx 入口，也可選 Cloudflare Tunnel 或外部代理）：

```bash
cd XPayincus
bash deploy/compose/panel.sh init https://pay.example.org https://admin.example.org admin@example.org
bash deploy/compose/panel.sh up build
```

部署包含 PostgreSQL 16、一個 Node API 程序及使用者／管理端前端。前端預設只發布本機 3000／3001，由選定 HTTPS 入口對外提供服務。主要入口 `docker-compose.yml` 引用 `compose.yaml`。後端依賴程序內鎖、防重放與快取狀態，禁止多副本，也不能與舊 systemd 後端同時寫入同一資料庫。Agent、Incus、RFW、ZFS 與宿主網路服務不容器化。

完整設定、來源 IP 信任及更新限制見 [Compose 操作說明](XPayincus/deploy/compose/README.md)。`panel.sh up`（同 `up pull`）有官方 `compose.release.yaml` 時按釘選版本核對 GHCR API 與共用 web 映像；沒有該檔的手動／自訂部署直接依既有 Compose image 執行 `pull --policy always`，無須先 update 納管或強迫 build。兩者都在全部必要映像準備成功後才停舊服務。完整倉庫也可明確使用 `panel.sh up build`。前端公開網址在容器啟動時產生，改網址不需重建映像。發行 override 只釘選映像；不支援容器內 systemd／sudo OTA。官方映像由根 Docker workflow 發布，部署前須確認對應 Actions 成功、GHCR 權限及兩種架構均可拉取。

## 資料庫匯出與匯入

在 `XPayincus/` 目錄執行，備份父目錄須先存在且目的檔不得已存在：

```bash
bash deploy/compose/panel.sh export /srv/private-backups/panel.dump
bash deploy/compose/panel.sh import /srv/private-backups/panel.dump --confirm-replace-incudal
```

這是維運 CLI，沒有新增管理面板按鈕。僅支援此 Compose 的 PostgreSQL 16，匯入只接受可信的 custom／tar archive。匯入會停止面板並先備份現有資料；成功或失敗都維持停機，確認版本、密鑰與憑證後再執行 `up`。不提供自動 migration 回滾。

DB 備份未加密，也不含 `.env`、secrets、Incus 客戶端憑證或實例資料。須另行安全保存，移機需保留原加密金鑰。不要提交備份、環境設定、私鑰或執行產物。

v1.0.2 新增 [舊宿主匯出與首次匯入指南](XPayincus/server/scripts/LEGACY_HOST_EXPORT.md)：`export-legacy-host.mjs` 可獨立匯出舊平鋪／current 布局的 DB、設定、原密鑰及憑證，不停止舊服務或自動切換。工具與指南隨原生 Panel 包及 Dashboard Compose 來源包交付；正式遷移須另行授權及隔離還原驗證。

## 版本與發行

根 `.github/workflows` 是 GitHub Actions 入口；子目錄 workflow 僅保留歷史參考。GitHub 執行統一 CI，涵蓋版本核對、面板型別檢查與守衛、前後端建置、Agent 測試與跨架構建置，以及 Compose 映像建置。

根 release workflow 在與根 `VERSION` 相符的 `v*` tag 推送後，先等待統一 CI 與版本檢查，再呼叫可重用的 `.github/workflows/docker.yml`，使用原生 amd64／arm64 runner 發布 API 與 web 多架構映像。彙整與 GitHub Release 發布均等待映像成功，再逐一附加完整 30 件資產；手動執行 release workflow 須選 `main`，會發布映像與 Actions artifacts，但不建立 GitHub Release。Release 發布不會自動部署或執行正式 OTA。

可直接從 Actions 的 **Publish Docker Images** 選 `main` 手動執行，依根 `VERSION` 發布 `ghcr.io/xiaolong-taiwan/xpayincus-{api,panel-web}:v1.0.14`，不等待完整 release 建置，也不建立 Git tag。Web 映像使用獨立的 `xpayincus-panel-web` package，Docker target 仍為 `web`，避免歷史 Web 套件的寫入權限限制。版本標籤須與同映像的 `sha-<完整 commit SHA>` index 完全一致；不同 commit 或缺少來源證據時拒絕覆寫。同 commit 重跑保留既有 SHA index。手動發布後若要發行同版本，Git tag 必須指向同一 commit；有任何後續修改須升版本。

版本同步、產物命名、SHA256 manifests、Agent 來源與舊 OTA 格式見 [RELEASE.md](RELEASE.md)。ZFS 僅提供 builder 原始碼包，並非已建置的核心模組。宿主安裝器仍可能使用明示釘選的歷史 RFW／ZFS 資產或 DKMS 回退，統一來源版本不代表二進位已重新發布。

## 文件與驗收

- [文件站原始碼](XPayincus/docs-site/README.md)
- [部署與反向代理](XPayincus/docs-site/docs/deployment/nginx.md)
- [Agent 安裝與來源設定](XPayincus/docs-site/docs/agent/install.md)
- [OTA 適用範圍](XPayincus/docs-site/docs/guide/ota-update.md)

歷史 release notes、交接及稽核紀錄保留作為當時證據，不用來宣稱統一版本已通過驗收。CI 結果以對應 commit 的 GitHub Actions 紀錄為準；容器啟動、資料庫還原、舊版遷移與實際可用性仍需隔離環境及目標主機驗收。歷史面板 v1.5.9 遷移至統一版 v1.0.x 必須受控處理，不自動降版，詳見發行文件。
