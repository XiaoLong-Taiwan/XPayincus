# XPayincus

統一管理 Dashboard、Server API、Agent、RFW 與 ZFS 的單一倉庫。根 [VERSION](VERSION) 是整體發行版本，目前為 `v1.0.2`；歷史子專案發行紀錄保留原版本，不代表目前部署版本。

| 邏輯端 | 來源目錄 | 部署方式 |
| --- | --- | --- |
| Server / Dashboard | `XPayincus/client`、`XPayincus/server` | 面板專用 Docker Compose；既有宿主部署另見面板文件 |
| Agent | `XPayincus-Agent` | Incus 宿主機二進位與 systemd |
| Agent 防火牆元件 | `XPayincus-Agent/components/rfw` | 宿主機 eBPF/XDP |
| Agent 儲存元件 | `XPayincus-Agent/components/zfs` | Debian 宿主機核心相依建置 |

前後端業務說明見 [面板 README](XPayincus/README.md)，宿主元件分別見 [Agent](XPayincus-Agent/README.md)、[RFW](XPayincus-Agent/components/rfw/README.md) 與 [ZFS](XPayincus-Agent/components/zfs/README.md)。宿主元件 bundle 與管理邊界見 [元件管理](XPayincus-Agent/components/README.md)；Go Agent 不直接載入 eBPF 或 ZFS 核心模組。pnpm workspace 位於 `XPayincus/`，不是統一倉庫根目錄。

## 面板 Docker Compose

在 Linux、Docker Engine 與 Compose v2.20.0 以上環境，先準備兩個獨立 HTTPS origin、DNS 及 TLS 憑證，再從統一倉庫根目錄執行（預設 Nginx 入口，也可選 Cloudflare Tunnel 或外部代理）：

```bash
cd XPayincus
bash deploy/compose/panel.sh init https://pay.example.org https://admin.example.org admin@example.org
bash deploy/compose/panel.sh up
```

部署包含 PostgreSQL 16、一個 Node API 程序及使用者／管理端前端。前端預設只發布本機 3000／3001，由選定 HTTPS 入口對外提供服務。主要入口 `docker-compose.yml` 引用 `compose.yaml`。後端依賴程序內鎖、防重放與快取狀態，禁止多副本，也不能與舊 systemd 後端同時寫入同一資料庫。Agent、Incus、RFW、ZFS 與宿主網路服務不容器化。

完整設定、來源 IP 信任及更新限制見 [Compose 操作說明](XPayincus/deploy/compose/README.md)。預設 `panel.sh up` 從 GHCR 拉取 `xiaolong-taiwan/xpayincus-api:v1.0.2` 與共用的 `xpayincus-web:v1.0.2`，全部拉取成功才停舊服務。`panel.sh up build` 可使用完整來源建置。前端公開網址在容器啟動時產生，改網址不需重建映像。發行包的 `compose.release.yaml` 只釘選映像；不支援容器內 systemd／sudo OTA。映像由根 Docker workflow 發布，部署前須確認對應 Actions 成功、GHCR 權限及兩種架構均可拉取。

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

根 release workflow 在與根 `VERSION` 相符的 `v*` tag 推送後，先等待統一 CI 與版本檢查，再呼叫可重用的 `.github/workflows/docker.yml`，使用原生 amd64／arm64 runner 發布 API 與 web 多架構映像。彙整與 GitHub Release 發布均等待映像成功，再逐一附加完整 26 件資產；手動執行 release workflow 須選 `main`，會發布映像與 Actions artifacts，但不建立 GitHub Release。Release 發布不會自動部署或執行正式 OTA。

可直接從 Actions 的 **Publish Docker Images** 選 `main` 手動執行，依根 `VERSION` 發布 `ghcr.io/xiaolong-taiwan/xpayincus-{api,web}:v1.0.2`，不等待完整 release 建置，也不建立 Git tag。版本標籤須與同映像的 `sha-<完整 commit SHA>` index 完全一致；不同 commit 或缺少來源證據時拒絕覆寫。同 commit 重跑保留既有 SHA index。手動發布後若要發行同版本，Git tag 必須指向同一 commit；有任何後續修改須升版本。

版本同步、產物命名、SHA256 manifests、Agent 來源與舊 OTA 格式見 [RELEASE.md](RELEASE.md)。ZFS 僅提供 builder 原始碼包，並非已建置的核心模組。宿主安裝器仍可能使用明示釘選的歷史 RFW／ZFS 資產或 DKMS 回退，統一來源版本不代表二進位已重新發布。

## 文件與驗收

- [文件站原始碼](XPayincus/docs-site/README.md)
- [部署與反向代理](XPayincus/docs-site/docs/deployment/nginx.md)
- [Agent 安裝與來源設定](XPayincus/docs-site/docs/agent/install.md)
- [OTA 適用範圍](XPayincus/docs-site/docs/guide/ota-update.md)

歷史 release notes、交接及稽核紀錄保留作為當時證據，不用來宣稱統一版本已通過驗收。CI 結果以對應 commit 的 GitHub Actions 紀錄為準；容器啟動、資料庫還原、舊版遷移與實際可用性仍需隔離環境及目標主機驗收。歷史面板 v1.5.9 遷移至統一版 v1.0.x 必須受控處理，不自動降版，詳見發行文件。
