# 統一發行

根層工作區包含 `XPayincus`、`XPayincus-Agent`、`XPayincus-RFW`、`XPayincus-ZFS`。版本唯一來源為根 `VERSION`，目前為 `v1.0.0`，本次不升版。格式必須為 canonical `vSemVer`：`vMAJOR.MINOR.PATCH[-prerelease][+build]`；核心數字與純數字預發行識別碼不得有前導零，識別碼不得為空，只接受 ASCII 英數與連字號。版本檔只允許單一版本及可選的一個 LF／CRLF 結尾，拒絕 BOM、空白或額外行。Compose 僅用於面板；Agent、RFW 與 ZFS 在宿主機執行，子目錄 workflow 僅供歷史參考。

GitHub Actions 必須從統一倉庫根層 checkout，四個子目錄須納入實際來源，不能只有 gitlink 或 submodule。Git 工作區是否已提交、推送及遠端 CI 是否成功，需另以當次紀錄確認，不應把文件中的工作區描述當作即時狀態。來源碼上傳不等於建立 GitHub Release，也不代表已部署。

## 流程

- `.github/workflows/ci.yml` 先核對全倉產品版本，再進行面板型別檢查、既有守衛、安裝守衛、雙端前端與後端建置，以及 Agent 測試與跨架構建置。
- `.github/workflows/release.yml` 於手動觸發或 `v*` tag 建置 Server/Agent/RFW 的 Linux amd64、arm64 產物，彙整 Dashboard Compose 原始碼包、ZFS builder 原始碼與 manifests，只上傳 Actions artifacts，不建立 GitHub Release、不部署。tag 必須與根 `VERSION` 一致。
- Server 與 RFW 使用各架構原生 runner。RFW 使用 musl、stable Rust、nightly rust-src 與 bpf-linker；Aya 相依使用既有 Cargo.lock，不修改 Cargo 版本。
- `assemble` 依賴所有二進位建置成功，下載至 `dist/incoming` 各自目錄，不直接合併覆寫。`collect-release-artifacts.mjs` 拒絕重複、異名、非一般檔案與缺件，只複製至空的 `dist/unified`；manifest 再核對完整產物集合。

## 本機建置

以下為待執行指令，本次未執行。需要 Bash、Node 22、pnpm 9.14.2、Go，以及相應 Rust/eBPF 工具鏈。Server/RFW 必須在對應架構的 Linux 原生環境執行，勿將 amd64 Prisma 依賴重新命名為 arm64 產物。

```bash
bash scripts/build-server-release.sh
bash scripts/build-agent-release.sh
bash scripts/build-rfw-release.sh
bash scripts/package-zfs-source.sh
```

每輪發行使用新的 `DIST_DIR`，不同元件可依序共用該目錄。腳本先核對目的地，再於同一檔案系統的暫存區完成產物，以 hard link 原子建立正式檔案；目的檔或符號連結均不能被覆寫，競爭建立同名檔案也會失敗。檔案系統須支援 hard link；失敗可能留下部分完成產物，重試請另用空目錄。JSON／雜湊採 exclusive create，重跑不覆寫。amd64 與 arm64 的 Server/RFW 輸出須收集到同一目錄，再併入 CI 產出的 Dashboard 包，才能執行 `RELEASE_REPOSITORY=owner/repository node scripts/generate-release-manifests.mjs dist/unified`。非 Git 的 Server 來源須設定 `SOURCE_COMMIT` 為實際來源 commit；工作流程使用根倉 commit。

`scripts/release-contract.mjs` 是版本與產物命名的共用入口。所有根層 build／package 腳本、收集器及 manifest 產生器均核對面板根、client、server、docs-site 的 package.json（不含 `v`）、Agent／ZFS VERSION（含 `v`），以及 RFW 的 `rfw`、`rfw-common`、`rfw-ebpf` 三個自家 crate `[package].version`（不含 `v`），要求與根版本逐字一致，包含預發行與 build metadata。Cargo 目前只接受各 crate 明寫的單一雙引號版本，不推測繼承版本；外部依賴版本及真實 ZFS 模組版本不屬於產品版本。全部入口需要 Node 22，不自動改寫版本，也不接受環境變數覆蓋根版本。

## Dashboard Compose 原始碼包

`scripts/package-dashboard-release.sh` 僅供 GitHub Actions 使用，封裝根倉庫 tracked `HEAD`，不讀取未提交的工作目錄修改。CI 必須 checkout 已包含必要檔案的 commit；未提交的工作目錄內容不會進入封裝，不能用編輯完成宣稱已產出完整發行包。

產物固定為 `xpayincus-dashboard-${VERSION}-compose.tar.gz`，與 OTA 的 `xpayincus-panel-*` 分開。保留根 `VERSION`、`XPayincus/package.json`、pnpm lock/workspace、完整 client/server 原始碼與 `XPayincus/deploy/compose`。封裝時另產生 `XPayincus/deploy/compose/compose.release.yaml`，並核對封裝來源的根／panel／client／server 版本。原有 `../..` build context、`incudal-panel` 專案名稱與單一 API 限制不變。

發行 override 指定三個本機建置映像：`xpayincus-dashboard-api:${IMAGE_TAG}`、`xpayincus-dashboard-user:${IMAGE_TAG}`、`xpayincus-dashboard-admin:${IMAGE_TAG}`，並加入 `org.opencontainers.image.version` 建置標籤。`IMAGE_TAG` 為根版本，僅將 Docker tag 不接受的 `+` 轉成 `_`；例如 `v1.0.0+build.1` 對應 `v1.0.0_build.1`。不截斷、不使用 `latest`，超過 Docker 的 128 字元限制即拒絕；原始版本與包名維持完整 SemVer。這些名稱不是已發布 registry 映像，workflow 不建置或推送 Docker 映像。

本次不修改來源 `compose.yaml`、Dockerfile 或 `panel.sh`。目前 `panel.sh` 固定載入單一 compose 檔，**不會自動套用發行 override**；若要整合其 `up` 流程，需要另行修改該入口。下列為包內手動套用標籤的待執行方式；所有後續 Compose 操作須沿用相同兩個 `--file`，不要與只載入原檔的 `panel.sh up` 混用：

```bash
cd XPayincus/deploy/compose
bash panel.sh init https://pay.example.com https://admin.example.com admin@example.com
docker compose --project-name incudal-panel --env-file .env --file compose.yaml --file compose.release.yaml config --quiet
docker compose --project-name incudal-panel --env-file .env --file compose.yaml --file compose.release.yaml build
docker compose --project-name incudal-panel --env-file .env --file compose.yaml --file compose.release.yaml stop user admin api
docker compose --project-name incudal-panel --env-file .env --file compose.yaml --file compose.release.yaml up -d --wait --wait-timeout 300
```

以 `git archive HEAD` 的明確路徑清單封裝，不收錄 Agent/RFW/ZFS 工作目錄。另排除任意層級的 `secrets`、`.env`、`.env.*`（含範例）、`.git`、`.gitmodules`、`node_modules`、dist、certs、常見私鑰/憑證容器、dump 與 log；拒絕符號連結。保留 Prisma migration SQL。這是路徑過濾，不是任意原始碼內容的密鑰掃描，根倉庫仍不得追蹤硬編碼憑證。`panel.sh init` 於部署時生成本機設定與 secrets，不隨包交付。

封裝腳本確認必要的已提交建置與 Compose 檔案存在，缺少 Dockerfile、compose、鎖檔或支援腳本會失敗。Dashboard 包會納入 `release-manifest.json`、個別 `.sha256` 與 `SHA256SUMS`，不放入面板 OTA manifest。

## 產物與 OTA 相容性

| 內容 | 檔名／格式 |
| --- | --- |
| Dashboard Compose 原始碼 | `xpayincus-dashboard-${VERSION}-compose.tar.gz` |
| Server（含雙端面板與原生正式依賴） | `xpayincus-panel-v1.0.0-linux-{amd64,arm64}.tar.gz` |
| Agent | `xpayincus-agent-v1.0.0-linux-{amd64,arm64}` 與單檔 `.gz` |
| Agent 舊格式 manifest | `manifest.json`，保留 `files.linux-amd64/linux-arm64`、`name/sha256/size/gzip` |
| 面板 OTA manifest | `ota-manifest.json` 與 `xpayincus-panel-v1.0.0-ota-manifest.json`，schemaVersion 1 |
| RFW | `xpayincus-rfw-v1.0.0-linux-{amd64,arm64}` |
| ZFS builder 原始碼 | `xpayincus-zfs-builder-v1.0.0-source.tar.gz`，不是核心模組 |
| 統一索引 | `release-manifest.json`，包含 ZFS source-only 狀態與執行需求 |
| 雜湊 | 個別產物 `.sha256` 與 `SHA256SUMS`，後者涵蓋產物及三份新增 JSON manifest，不自我雜湊 |

表中的 `v1.0.0` 是目前根 VERSION 的範例，所有檔名與彙整 artifact 名稱均隨根 VERSION 更新。

manifest 產生前目錄必須恰有 11 個一般檔案：Dashboard 包、ZFS source 包、兩個 panel tarball、兩個 Agent 二進位與兩個 `.gz`、兩個 RFW 二進位、Agent `manifest.json`。多餘檔案（含舊版、異名、既有 checksum／輸出 manifest）、缺件、目錄及符號連結均拒絕。Agent manifest 的 `files` 必須恰為 `linux-amd64` 與 `linux-arm64`，每項名稱、壓縮檔 SHA256、大小與 `gzip: true` 均核對。完成後再次核對原始 11 件、11 份個別 checksum、三份新增 JSON 與 `SHA256SUMS`，共 26 件。統一索引另記錄 Compose 包名、override、專案名及映像名稱；不將 Compose 包混入 OTA。

面板 OTA manifest 的 artifacts 僅列出兩個面板 tarball。舊 updater 只按 platform/arch 選取第一個相符產物，混入 Agent/RFW 會選錯，故統一索引與 OTA 索引分開。封裝保留 `client/dist/user`、`client/dist/admin`、`server/dist`、Prisma schema/migrations/config、templates、deploy、鎖檔、正式依賴、OTA/驗收腳本與 `version.json`。最低 updater 版本維持 `v0.0.3`。

根層 OTA manifest 與統一索引使用 `product: xpayincus`、`releaseChannel: unified-v1` 識別統一發行。新版面板 updater 要求 OTA schemaVersion 為數字 1、product/channel 相符，且 version/gitTag 與目標 Release tag 完全一致；缺少 channel 的歷史 `v1.5.9` 不會被當作統一通道更新。只有目標版本、平台、架構相符且唯一的 panel `.tar.gz` 可以使用，名稱與 URL 也必須對應該 Release 的唯一下載資產。

更新發現依語意版本降序排列，僅將嚴格高於目前版本的項目列為可更新；目前 tag 不在清單、重新發布舊 tag 或 build metadata 差異都不能觸發降版。預設／`auto`／`artifact` 模式透過 Releases API 與有效 OTA manifest 判斷，不因統一倉庫存在 `.git` 就自動允許 Git fallback。只有管理者明確設定 `SYSTEM_UPDATE_APPLY_MODE=git` 才允許來源建置入口；worker 仍保留既有 fallback 實作，這項入口守衛不代表 worker 已移除 fallback。

歷史面板 **v1.5.9 → 統一版 v1.0.0 必須受控遷移，不自動降版**。release channel 只區分發行身分，不改寫版本大小或宣稱資料庫相容。遷移前須另行授權、備份資料庫與設定、核對 schema／部署方式及回復方案，並於隔離環境驗證；不可改寫目前版本或利用 Git fallback 繞過降版守衛。既有舊 updater 不會因遠端 manifest 新增 channel 就自動取得這些保護，必須在受控遷移時確認 updater 版本。

Agent 根層腳本維持原有 Go 建置旗標、未壓縮／gzip 包名與 manifest 欄位，改在暫存區完成後以不覆寫方式交付。雜湊對應壓縮檔位元組，自升級先校驗再解壓，並維持由面板同源提供下載。離線使用時將 `manifest.json` 與兩架構 `.gz` 一起放入既有 Agent release 目錄；不以統一 manifest 取代它。面板 OTA 會保留既有 `agent-release`，本流程不強制覆寫已部署的 Agent。若未來改從統一遠端倉庫取得資產，須另行設定既有 Server 與 Agent release repository 選項；本次不改預設來源。

本次沒有產出二進位或宣稱 SHA256 已存在；雜湊必須由實際建置檔案計算。未來遠端發布若獲授權，需將彙整 artifact 內檔案逐一放到指定 repository 與根 VERSION 對應的 Release，下載 URL 才會可用；直接放上整個 Actions artifact zip 不符合既有 OTA。

## Agent 統一 Release 來源

面板設定 `INCUDAL_RELEASE_REPOSITORY=owner/unified-repository`，並清空舊 `INCUDAL_AGENT_RELEASE_REPOSITORY`，即可使用統一倉庫 `v*` Release。舊 Agent 倉庫設定非空時優先，預設 tag 仍為 `agent-v*`；兩者皆未設定時仍使用原獨立倉庫。`INCUDAL_AGENT_RELEASE_TAG_PREFIX` 未設定時自動依來源選擇，明確設空值代表使用 `v*`，設為 `agent-` 代表 `agent-v*`。這個前綴同時套用清單篩選及指定版本下載，不會在回退下載時固定改回舊 tag。

Agent 安裝模板沒有固定 GitHub 倉庫，維持 `/api/agent/manifest.json` 與 `/api/agent/binary` 同源代理；宿主安裝模板也使用這條路徑。無需將 release token 注入宿主機。靜態 production readiness 現在也接受統一來源。`INCUDAL_AGENT_RELEASE_DIR`、自訂 binary URL + SHA256 及舊配置均保留。修改來源後需重啟後端；面板 OTA 倉庫另以 `SYSTEM_UPDATE_RELEASE_REPOSITORY` 設定，不會隱式變更。Compose 部署需自行用 override 等方式向 API 容器傳入這些設定，本次不修改 Compose。

遠端代理仍要求兩架構未壓縮二進位 `xpayincus-agent-${VERSION}-linux-amd64` 與 `xpayincus-agent-${VERSION}-linux-arm64`，並自行串流計算與校驗 SHA256；會略過 draft 及缺少任一架構的 Release。只有 `.gz`、`manifest.json`、統一 manifest 或 Actions artifacts 都不足以提供遠端 Agent 更新。發布時仍應一併提供 `.gz`、Agent `manifest.json` 與 SHA256 清單供離線及下載校驗使用。私有倉庫沿用 `INCUDAL_AGENT_RELEASE_TOKEN`。

宿主安裝模板的 RFW 與 ZFS 舊獨立倉庫引用仍是已核驗舊版資產來源：RFW 需相符的版本及預先核驗 SHA256，ZFS 需匹配核心的實際模組。此修改不會把它們直接切到尚未發布的新資產，也不會以 ZFS builder 原始碼取代核心模組。

## ZFS 與 RFW 限制

ZFS 核心模組依賴 Debian 版本、CPU 架構、目標 kernel ABI、完整 matching headers、DKMS 與實際 ZFS 版本，不能由通用 Ubuntu runner 宣稱建置成功。這次僅封裝產品 VERSION、未修改的 builder 與 README，manifest 明示 `kernelModulesBuilt: false`。需在專用 Debian 編譯主機另行執行既有 `zfs-builder.sh --kernel <kernel>`，該腳本仍會詢問確認，並安裝套件及 DKMS 模組，不適合直接嵌入無人值守 CI。

待取得實際模組後，另記錄 ZFS 真實版本、kernel、architecture、vermagic 與 SHA256；不能把 ZFS 模組版本硬改為產品 v1.0.0，也不能跨 kernel 使用。Secure Boot 環境可能需要模組簽章。載入與實機驗證應在專用主機進行，不在面板 Compose 內執行。

RFW 產物名稱以根 VERSION 表示統一發行版本，Rust 三個自家 crate 版本由各自 Cargo.toml 維護，共用入口要求與根版本一致，建置腳本不會自動改寫；執行仍需 Linux 5.15+、XDP 支援及足夠權限。既有宿主安裝腳本仍釘選既有 RFW 版本與 SHA256，不會自動切換為這次產物。

## 交付狀態與待辦

依使用者指示，本次未執行測試、語法檢查、型別檢查、建置、雜湊驗證或遠端發布。因此相容性為依既有程式與守衛所做的格式設計，尚無執行通過證據。

後續需確認根層配置與四個來源均已納入可 checkout 的 commit，再於 Linux 執行統一 CI/release、檢查兩架構 tarball 內容與原生 Prisma、執行既有 OTA/Agent 守衛、重新計算 SHA256、在隔離環境驗證舊版 OTA 與 Agent 升級。ZFS 模組建置及目標核心實機載入仍待完成。任何遠端發布或正式 OTA 均需另行授權。
