# 統一發行

根層工作區包含 `XPayincus` 與 `XPayincus-Agent`，RFW／ZFS 實體來源分別位於 `XPayincus-Agent/components/rfw` 與 `XPayincus-Agent/components/zfs`。版本唯一來源為根 `VERSION`，目前準備 `v1.0.6`（未發布），最新正式版為 `v1.0.5`。格式必須為 canonical `vSemVer`：`vMAJOR.MINOR.PATCH[-prerelease][+build]`；核心數字與純數字預發行識別碼不得有前導零，識別碼不得為空，只接受 ASCII 英數與連字號。版本檔只允許單一版本及可選的一個 LF／CRLF 結尾，拒絕 BOM、空白或額外行。Compose 僅用於面板；Agent、RFW 與 ZFS 在宿主機執行，子目錄 workflow 僅供歷史參考。

GitHub Actions 必須從統一倉庫根層 checkout，面板、Agent 與 Agent 內兩個宿主元件須納入實際來源，不能只有 gitlink 或 submodule。Git 工作區是否已提交、推送及遠端 CI 是否成功，需另以當次紀錄確認，不應把文件中的工作區描述當作即時狀態。來源碼上傳不等於建立 GitHub Release，也不代表已部署。

## v1.0.6 版本準備（未發布）

- 同步統一版本欄位、Compose 映像／建置標籤及現行文件；Agent／RFW／ZFS 僅同步產品版本資訊。
- `up` 核對部署釘選版本的 registry index digest 與本機 RepoDigests，差異時強制拉取應用映像；同時預先補齊 DB、init 與所選入口映像，成功後才停止服務。跨版本更新由 `update` 固定 latest 後切換部署檔。
- 補齊舊 bootstrap 缺少 `update.py` 連結的相容處理，更新工具納入 Dashboard 必要封裝清單與 GitHub CI 回歸檢查；維持 28 件產物。
- 本次僅靜態核對，未在本機執行測試或構建，未提交、推送、發布或部署。未提交內容無法由遠端 CI checkout，GitHub 測試與構建結果仍待整合後確認。

## v1.0.5 歷史版本準備

- 同步根／Agent／ZFS VERSION、四份 package.json、RFW 三個自家 crate 與 Cargo.lock、Go Agent 預設版本、Compose 映像／建置標籤及現行發行 fixtures 與文件。
- 修正 Agent 遠端 manifest／gzip 持久快取說明，保留歷史版本紀錄、既有資產釘選與 `minimumUpdaterVersion`。
- 本次僅修改來源並靜態核對，未執行本機測試、建置、提交、發布或部署。

## v1.0.4 版本準備

- 同步根／Agent／ZFS VERSION、四份 package.json、RFW 自家 crate 與 Cargo.lock、Agent 預設版本及 Compose 映像／建置標籤。
- 修正備份降權讀取、tar 路徑轉換、PostgreSQL 16 client 與私有 Agent manifest token，補入封存內容及重新導向認證回歸測試。
- 本機關聯守衛、前後端型別檢查與版本契約通過；Docker daemon 未啟動，尚未驗證容器權限與 PostgreSQL 16 實際備份，也未發布或部署。

## v1.0.3 版本準備

- v1.0.2 已遠端發布，現行產品來源版本升為 v1.0.3，保留歷史發行紀錄與既有資產釘選。
- 同步根／Agent／ZFS VERSION、四份 package.json、RFW 三個自家 crate 與 Cargo.lock、Go Agent 預設版本、Compose 映像／建置標籤及 workflow 使用的 fixture。
- 更新現行文件與版本範例，修正統一 Release 產物總數為 28 件（12 件原始產物、12 份 checksum、三份新增 JSON manifest 與 SHA256SUMS）。

本次僅修改來源並靜態核對，未執行測試、建置、提交或發布 v1.0.3。

## v1.0.2 變更

- 同步根／Agent／ZFS VERSION、四份面板 package.json、RFW 三個自家 crate 與 Cargo.lock，以及 Go Agent 預設版本；第三方依賴及實際 ZFS 模組版本不變。
- RFW／ZFS 來源統一位於 `XPayincus-Agent/components/`，同步根／面板規範與中英文架構文件。
- Compose 新增 `docker-compose.yml` 入口、安裝模式、Nginx／Cloudflare Tunnel／外部代理選項；雙前端預設 loopback 3000／3001，保持單一 API。
- 新增舊無 Docker 宿主匯出工具與 [首次匯入指南](XPayincus/server/scripts/LEGACY_HOST_EXPORT.md)，納入原生 Panel 及 Dashboard Compose 來源包；匯出不自動停機、切換或保證 schema 相容。
- Dashboard 封裝與 prepare 階段核對新 Compose 入口、完整建置必要檔案、Nginx 模板及 legacy export 工具／指南，保留原資產命名與 OTA 邊界；現行產物集合為 28 件。

以上為來源變更紀錄，不代表已測試、建置、發布或部署。

## 流程

- `.github/workflows/ci.yml` 在 GitHub 執行，先核對全倉產品版本及 Agent 元件實體目錄、測試 Docker 發布守衛，再進行面板型別檢查、既有守衛、安裝守衛、雙端前端與後端建置、Agent 測試與跨架構建置、宿主元件 shell 語法檢查與 ZFS source 封裝，以及 Compose 的 API／雙前端映像建置。CI 明確疊加 `compose.build.yaml`，確保預設部署改成拉取映像後仍實際建置。
- `.github/workflows/release.yml` 於手動觸發或 `v*` tag 推送時，先執行統一 CI，再檢查根版本，呼叫可重用 Docker workflow 發布映像，並建置 Server/Agent/RFW 的 Linux amd64、arm64 產物，彙整 Dashboard Compose 原始碼包、ZFS builder 原始碼與 manifests，最後上傳 Actions artifacts。tag 必須與根 `VERSION` 一致；tag 流程成功後自動發布對應 GitHub Release，逐一附加完整 28 件資產。手動觸發須選 `main`，會發布映像及 Actions artifacts，不建立 GitHub Release。兩種流程均不部署或啟動正式 OTA。
- Server 與 RFW 使用各架構原生 runner。RFW 使用 musl、stable Rust、nightly rust-src 與 bpf-linker；Aya 相依使用既有 Cargo.lock，不修改 Cargo 版本。
- `assemble` 依賴所有二進位建置及 Docker 映像發布成功，`publish` 也明確依賴 Docker workflow。產物下載至 `dist/incoming` 各自目錄，不直接合併覆寫。`collect-release-artifacts.mjs` 拒絕重複、異名、非一般檔案與缺件，只複製至空的 `dist/unified`；manifest 再核對完整產物集合。

## GHCR 映像發布

`.github/workflows/docker.yml` 同時提供 `workflow_call` 與 `workflow_dispatch`。tag release 由 `release.yml` 在 CI／version 成功後呼叫；直接手動執行 **Publish Docker Images** 時必須選 `main`，立即按該次選定 commit 的根 `VERSION` 發布（本機準備版本 `v1.0.6`），不等待完整 CI／Release 產物，不建立 Git tag 或 GitHub Release。只允許 `xiaolong-taiwan/xpayincus` 發布到固定 GHCR namespace。

API 與 web 各自在 `ubuntu-24.04`／`ubuntu-24.04-arm` 原生 runner 建置 `linux/amd64`／`linux/arm64`，不使用 QEMU。Buildx 先推送各架構 digest，再合併兩架構 OCI index 至 `ghcr.io/xiaolong-taiwan/xpayincus-{api,panel-web}:sha-<完整 commit SHA>` 及版本標籤。Web 使用新的 `xpayincus-panel-web` package 避開歷史套件權限，Docker target 與 digest artifact 名稱仍使用 `web`；API 名稱不變。本機準備版本標籤為 `:v1.0.6`，不代表已發布。映像設定 OCI title、source、revision、version 等 labels，index 另設定 source／revision／version annotations，發布後檢查架構及來源。GHA cache 按 target／arch 分開；workflow 與 reusable caller 均授予 `packages: write`，使用內建 `GITHUB_TOKEN` 登入。

發布前同時核對 API／web：既有版本 index 的 revision、version、source 與兩種架構必須符合，且內容必須與該 commit 的 SHA index 完全一致，缺少 SHA 證據或不同 commit 一律失敗。所有 Docker workflow 共用 concurrency group 且不取消執行中的發布；重跑保留既有 SHA index，不以新建置覆寫它，再補上尚未發布的版本標籤。手動發布後，之後同版本 Git tag 必須指向相同 commit；若 main 已新增 commit，須升版，不能重新指定舊版映像。兩個 GHCR package 的標籤更新不是跨 package 原子交易，失敗可能留下部分完成標籤，可在同 commit 重跑補齊。

這是 workflow 層的防覆寫規則；具有 package 寫入權的外部工具仍能繞過。應限制其他發布來源與 token 權限。GHCR 首次發布的 package 可見性及 Actions 存取權需由倉庫管理者核對；公開部署需公開 package 或配置拉取認證。來源變更與本機測試不代表已發布映像，實際成功以 Actions 及 registry 為準。

## 本機建置

本機建置需要 Bash、Node 22、pnpm 9.14.2、Go，以及相應 Rust/eBPF 工具鏈。Server/RFW 必須在對應架構的 Linux 原生環境執行，勿將 amd64 Prisma 依賴重新命名為 arm64 產物。

```bash
bash scripts/build-server-release.sh
bash scripts/build-agent-release.sh
bash scripts/build-rfw-release.sh
bash scripts/package-zfs-source.sh
```

每輪發行使用新的 `DIST_DIR`，不同元件可依序共用該目錄。腳本先核對目的地，再於同一檔案系統的暫存區完成產物，以 hard link 原子建立正式檔案；目的檔或符號連結均不能被覆寫，競爭建立同名檔案也會失敗。檔案系統須支援 hard link；失敗可能留下部分完成產物，重試請另用空目錄。JSON／雜湊採 exclusive create，重跑不覆寫。amd64 與 arm64 的 Server/RFW 輸出須收集到同一目錄，再併入 CI 產出的 Dashboard 包，才能執行 `RELEASE_REPOSITORY=owner/repository node scripts/generate-release-manifests.mjs dist/unified`。非 Git 的 Server 來源須設定 `SOURCE_COMMIT` 為實際來源 commit；工作流程使用根倉 commit。

`scripts/release-contract.mjs` 是版本與產物命名的共用入口。所有根層 build／package 腳本、收集器及 manifest 產生器均核對面板根、client、server、docs-site 的 package.json（不含 `v`）、Agent／ZFS VERSION（含 `v`），以及 RFW 的 `rfw`、`rfw-common`、`rfw-ebpf` 三個自家 crate `[package].version`（不含 `v`），要求與根版本逐字一致，包含預發行與 build metadata。Cargo 目前只接受各 crate 明寫的單一雙引號版本，不推測繼承版本；外部依賴版本及真實 ZFS 模組版本不屬於產品版本。全部入口需要 Node 22，不自動改寫版本，也不接受環境變數覆蓋根版本。

Agent 宿主元件以 [bundle／管理文件](XPayincus-Agent/components/README.md) 整合，不新增宿主 bundle 資產，也不改 Agent manifest 或面板 OTA manifest。共用契約先要求 `XPayincus-Agent/components/rfw` 與 `XPayincus-Agent/components/zfs` 是實體目錄，拒絕舊頂層元件目錄殘留，再從新路徑核對 RFW crate 與 ZFS 產品版本。Go Agent 不載入 eBPF／ZFS 核心功能，不隨自身升級啟停或替換宿主元件。

## Dashboard Compose 原始碼包

`scripts/package-dashboard-release.sh` 僅供 GitHub Actions 使用，封裝根倉庫 tracked `HEAD`，不讀取未提交的工作目錄修改。CI 必須 checkout 已包含必要檔案的 commit；未提交的工作目錄內容不會進入封裝，不能用編輯完成宣稱已產出完整發行包。

產物固定為 `xpayincus-dashboard-${VERSION}-compose.tar.gz`，與 OTA 的 `xpayincus-panel-*` 分開。保留根 `VERSION`、`XPayincus/package.json`、pnpm lock/workspace、完整 client/server 原始碼與 `XPayincus/deploy/compose`。封裝時另產生 `XPayincus/deploy/compose/compose.release.yaml`，並核對封裝來源的根／panel／client／server 版本。原有 `../..` build context、`incudal-panel` 專案名稱與單一 API 限制不變。

同一次打包另從 committed `download.sh` 輸出可下載的 `xpayincus-compose-${VERSION}.sh`，納入統一索引、個別 `.sha256` 與 `SHA256SUMS`。使用者先驗證入口，再以 `install DIRECTORY VERSION SHA256` 或 `update DIRECTORY VERSION SHA256` 下載該版本 Dashboard 包；部署檔案更新保留私人資料，另執行 `panel.sh up` 才 pull／重建。入口目前僅接受正式 `vX.Y.Z`；完整命令與部署限制見 [Compose 文件](XPayincus/deploy/compose/README.md#安全下載入口建議-pull-部署)。

Dashboard 包及來源 install 同時交付 `deploy/compose/update.py`，prepare／package 必要清單檢查缺件。宿主 `panel.sh update` 無參數時固定官方最新正式 Release，從同 tag 的 `SHA256SUMS` 取得 checksum，驗證目標及目前官方部署檔，核對 project／路徑／bind mounts 後備份並 up；標準手動部署可納管，自訂衝突拒絕，不改私人資料與 project 識別。顯式參數介面維持僅準備；不新增 Release 資產，28 件集合不變。此來源變更尚須正式交付，既有線上舊工具不會自動取得此功能。

發行 override 僅釘選 `ghcr.io/xiaolong-taiwan/xpayincus-api:${IMAGE_TAG}` 與雙前端共用的 `ghcr.io/xiaolong-taiwan/xpayincus-panel-web:${IMAGE_TAG}`，不加入 build。`IMAGE_TAG` 為根版本，僅將 Docker tag 不接受的 `+` 轉成 `_`；例如 `v1.0.3+build.1` 對應 `v1.0.3_build.1`。不截斷、不使用 `latest`，超過 128 字元即拒絕；原始版本與包名維持完整 SemVer。預設 `panel.sh up` 核對釘選正式版本的 registry digest 與本機 RepoDigests，差異時強制拉取應用映像，並補齊其餘所需映像，成功才停舊服務；不查詢 latest，跨版本使用 `update`。`up build` 疊加 `compose.build.yaml`、加入版本建置標籤並從完整來源建置，另先下載其餘映像。兩者啟動時均禁止臨時 build／pull。前端以啟動時產生的公開 runtime-config.js 設定網址。根 Docker workflow 負責發布兩種架構映像，Release 彙整前必須成功；來源包或 manifest 本身不代表 registry 已有映像。

`panel.sh` 預設使用 `docker-compose.yml` 引用 `compose.yaml`；若有 `compose.release.yaml`，則改載入 `compose.yaml` 再疊加 override，避免 include 與 override 同名服務衝突。安裝模式透過 `BUILD_CONTEXT=./source` 定位來源，不產生 `.state/build-context.yaml`。發行 override 必須可讀且非空；`up`、`down`、`status`、`logs`、`export`、`import` 共用相同設定，不需手動補上 `--file`。在解壓後的來源包可直接執行（預設 Nginx，啟動前須準備兩站 TLS 憑證；其他模式見 Compose 文件）：

```bash
cd XPayincus/deploy/compose
bash panel.sh init https://pay.example.com https://admin.example.com admin@example.com
bash panel.sh up
bash panel.sh status
```

以 `git archive HEAD` 的明確路徑清單封裝，不收錄 Agent/RFW/ZFS 工作目錄。另排除任意層級的 `secrets`、`.env`、`.env.*`（含範例）、`.git`、`.gitmodules`、`node_modules`、dist、certs、常見私鑰/憑證容器、dump 與 log；拒絕符號連結。保留 Prisma migration SQL。這是路徑過濾，不是任意原始碼內容的密鑰掃描，根倉庫仍不得追蹤硬編碼憑證。`panel.sh init` 於部署時生成本機設定與 secrets，不隨包交付。

`package-dashboard-release.sh` 與 `prepare-compose-release.mjs` 均確認必要來源為可讀、非空的一般檔案，涵蓋 workspace／鎖檔、前後端建置入口及設定、Prisma schema／migration lock、宿主模板、legacy export 工具／指南，以及 `docker-compose.yml`、`compose.yaml`、Dockerfile／ignore、panel／API／origin entrypoint、三份 Nginx 模板、README 與外部 HTTPS 代理範例。缺件會在產生發行 override 或封裝前失敗。Dashboard 包會納入 `release-manifest.json`、個別 `.sha256` 與 `SHA256SUMS`，不放入面板 OTA manifest。

## 產物與 OTA 相容性

| 內容 | 檔名／格式 |
| --- | --- |
| Dashboard Compose 原始碼 | `xpayincus-dashboard-${VERSION}-compose.tar.gz` |
| Compose bootstrap 入口 | `xpayincus-compose-${VERSION}.sh` |
| Server（含雙端面板與原生正式依賴） | `xpayincus-panel-v1.0.6-linux-{amd64,arm64}.tar.gz` |
| Agent | `xpayincus-agent-v1.0.6-linux-{amd64,arm64}` 與單檔 `.gz` |
| Agent 舊格式 manifest | `manifest.json`，保留 `files.linux-amd64/linux-arm64`、`name/sha256/size/gzip` |
| 面板 OTA manifest | `ota-manifest.json` 與 `xpayincus-panel-v1.0.6-ota-manifest.json`，schemaVersion 1 |
| RFW | `xpayincus-rfw-v1.0.6-linux-{amd64,arm64}` |
| ZFS builder 原始碼 | `xpayincus-zfs-builder-v1.0.6-source.tar.gz`，不是核心模組 |
| 統一索引 | `release-manifest.json`，包含 ZFS source-only 狀態與執行需求 |
| 雜湊 | 個別產物 `.sha256` 與 `SHA256SUMS`，後者涵蓋產物及三份新增 JSON manifest，不自我雜湊 |

表中的 `v1.0.6` 是目前根 VERSION 的未發布範例，所有檔名與彙整 artifact 名稱均隨根 VERSION 更新。

manifest 產生前目錄必須恰有 12 個一般檔案：Dashboard 包、Compose bootstrap 腳本、ZFS source 包、兩個 panel tarball、兩個 Agent 二進位與兩個 `.gz`、兩個 RFW 二進位、Agent `manifest.json`。多餘檔案（含舊版、異名、既有 checksum／輸出 manifest）、缺件、目錄及符號連結均拒絕。Agent manifest 的 `files` 必須恰為 `linux-amd64` 與 `linux-arm64`，每項名稱、壓縮檔 SHA256、大小與 `gzip: true` 均核對。完成後再次核對原始 12 件、12 份個別 checksum、三份新增 JSON 與 `SHA256SUMS`，共 28 件。統一索引另記錄 Compose 包名、override、專案名及映像名稱；不將 Compose 包或 bootstrap 混入 OTA。

面板 OTA manifest 的 artifacts 僅列出兩個面板 tarball。舊 updater 只按 platform/arch 選取第一個相符產物，混入 Agent/RFW 會選錯，故統一索引與 OTA 索引分開。封裝保留 `client/dist/user`、`client/dist/admin`、`server/dist`、Prisma schema/migrations/config、templates、deploy、鎖檔、正式依賴、OTA/驗收腳本與 `version.json`。最低 updater 版本維持 `v0.0.3`。

原生 Panel 的 `build-server-release.sh` 另明確複製 `server/scripts/export-legacy-host.mjs` 與 `server/scripts/LEGACY_HOST_EXPORT.md`，不將整個 server 測試／開發腳本目錄納入。解壓後可直接以 Node 執行工具，仍需 Linux、相容的 PostgreSQL CLI；指南的 Compose 相對連結在原生包內也保留有效。這是交付工具，不會在建置、OTA 或服務啟動時自動執行匯出。

根層 OTA manifest 與統一索引使用 `product: xpayincus`、`releaseChannel: unified-v1` 識別統一發行。新版面板 updater 要求 OTA schemaVersion 為數字 1、product/channel 相符，且 version/gitTag 與目標 Release tag 完全一致；缺少 channel 的歷史 `v1.5.9` 不會被當作統一通道更新。只有目標版本、平台、架構相符且唯一的 panel `.tar.gz` 可以使用，名稱與 URL 也必須對應該 Release 的唯一下載資產。

更新發現依語意版本降序排列，僅將嚴格高於目前版本的項目列為可更新；目前 tag 不在清單、重新發布舊 tag 或 build metadata 差異都不能觸發降版。預設／`auto`／`artifact` 模式透過 Releases API 與有效 OTA manifest 判斷，不因統一倉庫存在 `.git` 就自動允許 Git fallback。只有管理者明確設定 `SYSTEM_UPDATE_APPLY_MODE=git` 才允許來源建置入口；worker 仍保留既有 fallback 實作，這項入口守衛不代表 worker 已移除 fallback。

歷史面板 **v1.5.9 → 統一版 v1.0.x（含 v1.0.0、v1.0.1、v1.0.2、v1.0.3）必須受控遷移，不自動降版**。release channel 只區分發行身分，不改寫版本大小或宣稱資料庫相容。遷移前須另行授權、備份資料庫與設定、核對 schema／部署方式及回復方案，並於隔離環境驗證；不可改寫目前版本或利用 Git fallback 繞過降版守衛。既有舊 updater 不會因遠端 manifest 新增 channel 就自動取得這些保護，必須在受控遷移時確認 updater 版本。

Agent 根層腳本維持原有 Go 建置旗標、未壓縮／gzip 包名與 manifest 欄位，改在暫存區完成後以不覆寫方式交付。雜湊對應壓縮檔位元組，自升級先校驗再解壓，並維持由面板同源提供下載。離線使用時將 `manifest.json` 與兩架構 `.gz` 一起放入既有 Agent release 目錄；不以統一 manifest 取代它。面板 OTA 會保留既有 `agent-release`，本流程不強制覆寫已部署的 Agent。從統一遠端倉庫取得資產時，須設定既有 Server 與 Agent release repository 選項；發布統一 Release 不會自動變更預設來源。

SHA256 由 workflow 對實際建置檔案計算。tag 流程將彙整後的 28 件檔案逐一上傳至目前 repository、根 VERSION 對應的 GitHub Release，供 manifest 內的下載 URL 使用；手動觸發只保留 Actions artifacts，不提供對應的 Release 下載資產。直接把整個 Actions artifact zip 當成單一 Release 資產不符合既有 OTA。

## Agent 統一 Release 來源

面板設定 `INCUDAL_RELEASE_REPOSITORY=owner/unified-repository`，並清空舊 `INCUDAL_AGENT_RELEASE_REPOSITORY`，即可使用統一倉庫 `v*` Release。舊 Agent 倉庫設定非空時優先，預設 tag 仍為 `agent-v*`；兩者皆未設定時仍使用原獨立倉庫。`INCUDAL_AGENT_RELEASE_TAG_PREFIX` 未設定時自動依來源選擇，明確設空值代表使用 `v*`，設為 `agent-` 代表 `agent-v*`。這個前綴同時套用清單篩選及指定版本下載，不會在回退下載時固定改回舊 tag。

Agent 安裝模板沒有固定 GitHub 倉庫，維持 `/api/agent/manifest.json` 與 `/api/agent/binary` 同源代理；宿主安裝模板也使用這條路徑。無需將 release token 注入宿主機。靜態 production readiness 現在也接受統一來源。`INCUDAL_AGENT_RELEASE_DIR`、自訂 binary URL + SHA256 及舊配置均保留。修改來源後需重啟後端；面板 OTA 倉庫另以 `SYSTEM_UPDATE_RELEASE_REPOSITORY` 設定，不會隱式變更。Compose 的 `.env` 支援 `INCUDAL_RELEASE_REPOSITORY` 與 `INCUDAL_AGENT_RELEASE_REPOSITORY`，並明確傳入 API；其他額外 API 設定仍須透過部署設定明確注入。

遠端代理優先讀取 Release 的 Agent `manifest.json`，核對版本、schema、`minimumUpdaterVersion` 格式、雙架構檔名及資產大小，按 manifest 下載兩架構資產，支援 `xpayincus-agent-${VERSION}-linux-{amd64,arm64}.gz`；SHA256 對應壓縮檔位元組，保留 manifest 的 `gzip` 語意，由安裝器／Agent 校驗後解壓。只有缺少 Agent manifest 時，才回退到兩架構未壓縮二進位並自行計算 SHA256；無效 manifest 或資產驗證失敗會直接拒絕。統一 manifest 與 Actions artifacts 不取代 Agent manifest；統一 Release 仍須提供完整 28 件資產。私有倉庫沿用 `INCUDAL_AGENT_RELEASE_TOKEN`。

首次 manifest／安裝或更新下載請求會按需取得資產，兩架構全部通過版本、大小與 SHA256 驗證後才原子發布持久快取；後續 binary 由本地提供，重啟後仍可使用。快取以 repository、tag prefix 與版本隔離，保留舊版本供已發出的更新 URL 使用，目前不自動清除。`INCUDAL_AGENT_CACHE_DIR` 可指定服務帳號可寫的絕對目錄；預設為 `$XDG_CACHE_HOME/xpayincus-agent`，未設定 XDG 時為 `~/.cache/xpayincus-agent`。Compose 使用 `/opt/incudal/config/agent-cache`，沿用 `./config` 持久掛載及 UID 1000 權限。最新 Release 每五分鐘按請求重新探索；探索網路失敗時可沿用已驗證快取，無效 manifest／資產不會被舊快取繞過。`INCUDAL_AGENT_RELEASE_DIR` 仍優先讀取手動準備的完整本地資產，設定後不自動覆寫；無效本地 manifest 直接拒絕。

宿主安裝模板的 RFW 與 ZFS 舊獨立倉庫引用仍是已核驗舊版資產來源：RFW 需相符的版本及預先核驗 SHA256，ZFS 需匹配核心的實際模組。統一 Release 發布不會自動切換這些釘選來源，也不會以 ZFS builder 原始碼取代核心模組。

## ZFS 與 RFW 限制

ZFS 核心模組依賴 Debian 版本、CPU 架構、目標 kernel ABI、完整 matching headers、DKMS 與實際 ZFS 版本，不能由通用 Ubuntu runner 宣稱建置成功。統一發行僅封裝產品 VERSION、builder 與 README，manifest 明示 `kernelModulesBuilt: false`。需在專用 Debian 編譯主機另行執行既有 `zfs-builder.sh --kernel <kernel>`，該腳本仍會詢問確認，並安裝套件及 DKMS 模組，不適合直接嵌入無人值守 CI。

待取得實際模組後，另記錄 ZFS 真實版本、kernel、architecture、vermagic 與 SHA256；不能把 ZFS 模組版本硬改為產品 v1.0.6，也不能跨 kernel 使用。Secure Boot 環境可能需要模組簽章。載入與實機驗證應在專用主機進行，不在面板 Compose 內執行。

RFW 產物名稱以根 VERSION 表示統一發行版本，Rust 三個自家 crate 版本由各自 Cargo.toml 維護，共用入口要求與根版本一致，建置腳本不會自動改寫；執行仍需 Linux 5.15+、XDP 支援及足夠權限。既有宿主安裝腳本仍釘選既有 RFW 版本與 SHA256，不會自動切換為統一 Release 產物。

## 驗證與部署邊界

測試與建置由 GitHub CI 執行，是否通過須查閱對應 commit 的 Actions 紀錄。Release 流程另負責雙架構產物、完整集合與 SHA256 檢查；是否已發布及資產是否齊全，須核對對應 tag 的 Release 與 28 件資產。CI 成功、Release 發布與目標主機驗收是不同證據。

部署前仍須在隔離環境驗證資料庫還原、歷史版本受控遷移、OTA 與 Agent 升級，並核對兩架構 tarball 內容及原生 Prisma 相依。Compose 建置不代表已完成容器啟動、TLS、登入或付款流程驗收；ZFS 模組須另行建置並在目標核心實機載入驗證。推送相符 tag 會自動發布 Release，正式部署與 OTA 仍需另行授權。
