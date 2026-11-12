# 面板 Compose v1.0.12 部署與 PostgreSQL 匯出匯入

本配置僅部署 Dashboard／面板：使用者前端、管理端前端、單一 API 程序及 PostgreSQL 16。Agent、Incus、ZFS、RFW 與宿主機網路服務維持既有宿主機部署，不提供容器、不掛載 Docker socket、不使用 privileged 或 host network。原 systemd／Nginx 配置保留；發行入口是統一倉庫根 `.github/workflows`，子目錄 workflow 僅作歷史參考。

本文件描述統一版 v1.0.12 Compose 配置（v1.0.11 已正式發布，發布狀態以 GitHub Release 為準）；整體發行版本以根 `VERSION` 為準。根封裝腳本會核對新入口、Nginx 模板、支援腳本與 legacy export 工具／指南完整性。GitHub CI 包含 Compose 的 API／雙前端映像建置及 committed Dashboard 封裝，不推送 registry，也不自動部署；完整發行規則見根 [RELEASE.md](../../../RELEASE.md)。

## 前置條件

- Linux 主機，Bash、OpenSSL、util-linux `flock`、GNU coreutils／tar／find／awk、Docker Engine 與 Compose v2.20.0 以上外掛；需要 `include`、`up --wait --wait-timeout`、`service_completed_successfully` 與 bind mount 的 `create_host_path: false`，不支援舊版 `docker-compose` v1。操作帳號須能存取 Docker daemon 並讀寫部署目錄，初始化與後續操作請使用同一帳號。
- pull 模式需能存取 Compose 所設定的映像 registry；有官方 `compose.release.yaml` 時另需 Python 3.9 以上與 Docker Buildx 核對 digest。不需要本機 Node、pnpm 或完整來源。選用 build 模式才需要完整面板原始碼、pnpm lockfile，以及 Debian、npm 與 Prisma 下載來源；建置使用 Node 22、pnpm 9.14.2。
- 兩個不同 hostname 的 HTTPS origin 與 DNS。選擇自搭 Nginx 時準備 TLS 憑證；選擇 Cloudflare Tunnel 時準備 remotely-managed tunnel。Dashboard／管理端預設為 `127.0.0.1:3000`／`127.0.0.1:3001`，API 的容器內部 3001 不發布至宿主機。
- 僅部署一套 `incudal-panel`。API 固定容器名稱，禁止 `--scale api=2`、額外 Compose project 或與舊 systemd 後端同時連線至同一 DB。API 的程序內狀態要求單實例。

Windows 工作區可編輯這些檔案；部署 CLI 應在 Linux 主機或具有 Docker 存取權的 WSL Linux 檔案系統執行，並使用 LF 換行。不要透過 PowerShell 5 的文字重導向處理二進位備份。

### 原始碼與必要檔案

可使用完整倉庫執行 `up` 或 `up build`，或解壓已發布的 Dashboard Compose 原始碼包 `xpayincus-dashboard-<版本>-compose.tar.gz`。使用官方發行包時保留附帶的 `compose.release.yaml`；也可只複製該包完整 `deploy/compose/` 目錄，執行 init 與預設 pull 部署。手動／自訂部署沒有該 release 檔時，`up` 與 `up pull` 直接依既有 Compose 的 image 拉取，不要求先以 `update` 納管或改用 build。只有 build 模式需要保留完整 `XPayincus/` 相對目錄；`compose.build.yaml` 的預設 build context `../..` 解析為 `XPayincus/`，安裝模式改用 `BUILD_CONTEXT=./source`。

根打包腳本透過 `prepare-compose-release.mjs` 在包內產生僅含 image 的 `compose.release.yaml`。本次發行目標 API 使用 `ghcr.io/xiaolong-taiwan/xpayincus-api:v1.0.12`，user／admin 共用 `ghcr.io/xiaolong-taiwan/xpayincus-panel-web:v1.0.12`，發布狀態以 registry 與 Actions 為準；Web 的 Docker target 仍為 `web`。預設設定不含 build；`bash panel.sh up build` 才疊加 `compose.build.yaml` 並加入版本建置標籤。有官方 release 檔時，`up` 依部署釘選版本解析 GHCR registry index digest，只有本機 RepoDigests 含相同 digest 才略過應用映像 pull；缺少或不同則強制拉取，官方部署檔換版使用 `update`。無 release 檔時直接執行 Compose `pull --policy always`，拉取目前啟用服務的 image。映像須已發布且支援目標架構；官方映像由根 Docker workflow 發布。若 digest 無法解析或 pull 失敗，舊服務不會先停止。私有映像請先用安全方式登入對應 registry。

主要入口為 `docker-compose.yml`，透過 Compose `include` 引用 `compose.yaml`；所有服務、網路、secret 僅定義於 `compose.yaml`，舊的 `-f compose.yaml` 用法仍相容。缺少新入口的舊部署，CLI 與 `init` 回退使用 `compose.yaml`；已存在但損壞的入口不會被忽略。避免同時載入兩個入口。若存在 `compose.release.yaml`，CLI 使用 `compose.yaml` 再疊加該 override，避免 `include` 與 override 同名服務衝突；檔案必須可讀且非空。`init` 會寫入對應 `COMPOSE_FILE`，讓部署目錄的 `docker compose` 也採相同配置。`up`、`down`、`status`、`logs`、`export`、`import` 共用配置；`install`、`init` 與 help 不呼叫 Compose。

OAuth 管理頁的供應商 callback 顯示為使用者 origin 下的 `/api/oauth/callback/{github,google,discord}`，以後端 `SITE_URL`（Compose 使用 `FRONTEND_URL`）為準，不使用管理頁 origin。只有舊後端缺少網址欄位時才採前端 `customerBaseUrl`／`VITE_CUSTOMER_BASE_URL`；新後端明確回傳 null 或無效設定時顯示空白，請先修正後端公開網址。此處列出使用者登入 callback；若啟用管理員 OAuth 登入，仍須依後端 `ADMIN_FRONTEND_URL` 另行註冊管理端 callback。

| 路徑（相對於 `XPayincus/`） | 用途 |
| --- | --- |
| `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` | 固定 workspace 與依賴版本，使用 frozen lockfile 安裝 |
| 完整 `client/` | 包含 package、Vite／TypeScript 設定、`index.html`、`src/`、`public/`，建置兩套獨立前端 |
| 完整 `server/` | 包含 package、TypeScript 設定、`src/`、Prisma config、schema 及完整 migration 歷史 |
| `server/templates/install.sh`、`agent-install.sh`、`caddy.sh` | API 提供的宿主安裝模板；仍由宿主執行，保留在 `server/templates/`，不靠 TypeScript 複製 |
| `server/scripts/export-legacy-host.mjs`、`LEGACY_HOST_EXPORT.md` | 舊宿主匯出工具與首次匯入指南，也隨原生 Panel 包交付 |
| `deploy/compose/Dockerfile`、`Dockerfile.dockerignore` | 多階段建置及專屬 build context 排除規則，兩檔皆須保留 |
| `deploy/compose/api-entrypoint.sh`、`nginx.conf.template` | API secret／migration／單程序啟動及雙前端 Nginx 路由 |
| `deploy/compose/docker-compose.yml`、`compose.yaml`、`panel.sh` | 主要入口、唯一服務定義與部署 CLI |
| `origin-entrypoint.sh`、`edge-nginx.conf.template`、`tunnel-nginx.conf.template` | 選用入口的 hostname 產生與可信來源 IP 轉送 |
| `https-proxy.conf.example` | 使用既有宿主 Nginx 的範例 |

API 映像保留根 `node_modules` 的 pnpm store、`server/node_modules` 連結、已產生的 Prisma client 與 Prisma CLI；不要只複製 `server/dist/`。建置用的 `DATABASE_URL` 為無實際資料庫的佔位 URL，供 Prisma generate 載入設定；建置不執行 migration、不需要正式 DB 密碼。

Agent Release 首次被 manifest／安裝或更新下載請求使用時，API 會從已設定的可信 GitHub repository 按需下載 manifest 與雙架構 binary，全部通過版本、大小及 SHA-256 驗證後才原子發布。Compose 設定 `INCUDAL_AGENT_CACHE_DIR=/opt/incudal/config/agent-cache`，沿用既有 `./config` 持久掛載與 UID 1000 寫入權限，不需新增 volume；首次請求較慢且需連線 GitHub，後續 binary 由本地提供。每五分鐘按請求檢查最新 Release；探索 GitHub 失敗時可繼續使用已驗證快取，無效 manifest／資產不會被舊版繞過。原生部署可設定同一環境變數為服務帳號可寫的絕對目錄，預設為 `$XDG_CACHE_HOME/xpayincus-agent`（未設定 XDG 時為服務帳號的 `~/.cache/xpayincus-agent`）。快取按 repository、tag prefix 及版本分開，保留舊版供已發出的更新 URL 使用，目前不自動清除舊版。`INCUDAL_AGENT_RELEASE_DIR` 仍優先讀取手動／本機建置的完整資產，設定後不自動覆寫；無效本地 manifest 直接拒絕。安裝腳本 URL 仍為 `/api/agent/install.sh`；此快取改善後續資產下載，不能修正代理本身造成的腳本 404。

網路測試僅出現在登入後的商品購買畫面，顯示管理員核准且綁定該商品／host 的 DNS 目標。舊目標須在管理設定重新建立綁定，未綁定設定不會提供給客戶。瀏覽器直接請求目標的 `https://hostname/.well-known/network-probe`；節點須提供有效 TLS、小型 2xx 回應、`Cache-Control: no-store` 及允許使用者前端來源的 CORS，避免 CDN／反向代理至其他節點。此數字是瀏覽器 HTTPS 回應標頭耗時，非 TCP／ICMP RTT。瀏覽器自行解析 DNS，API 無法鎖定瀏覽器的解析結果；目標 DNS 必須由可信管理員維護，不能委託不受信任的租戶控制。

TCP／ICMP 提供可複製的公開 IP 指令，請客戶於本機或自己已授權主機執行；目前 Agent 沒有遠端測試任務協定；客戶可明確承認未驗證後人工提交本機 TCP／ICMP 結果，瀏覽器 HTTPS 結果也可保存。紀錄一律標示 `verified: false`，須符合商品／host 與核准目標綁定，不能當作 Agent 實測或 SLA 證據。最多保留 30 天，每位 owner 最多 100 筆、全域最多 10000 筆，容量達限會提早移除；須一併交付 `20261111050000_network_probe_records` migration。原 API `/network-probe/test` 僅保留管理員診斷，來源仍標示 `panel-api`。API 使用 `iputils-ping`，以 node GID 1000 搭配 `net.ipv4.ping_group_range: '1000 1000'` 開啟非特權 ICMP socket，保留移除 `NET_RAW` 及 `no-new-privileges`；主機須支援此 namespaced sysctl。目標防火牆封鎖 ICMP 仍會回報無回應。

## 首次部署

### 安全下載入口（建議 pull 部署）

Release 提供版本化的 `xpayincus-compose-vX.Y.Z.sh`（原始碼為 `download.sh`）；需要 Linux、Bash、Python 3.9 以上、curl、sha256sum、flock、find 與 mktemp。latest 僅解析官方 `XiaoLong-Taiwan/XPayincus` 正式 Release，下載前固定為 `vX.Y.Z`；不接受自訂下載 URL。Debian／Ubuntu 可先安裝 `sudo apt-get install bash python3 curl ca-certificates coreutils util-linux findutils openssl`。

先下載入口到私有暫存目錄、檢查 Bash 語法，再啟動 Dashboard 數字選單：

```bash
bash -c 'set -eu; d=$(mktemp -d); trap '\''rm -rf -- "$d"'\'' EXIT; curl --fail --silent --show-error --location --proto =https --proto-redir =https --output "$d/compose.sh" https://raw.githubusercontent.com/XiaoLong-Taiwan/XPayincus/main/XPayincus/deploy/compose/download.sh; bash -n "$d/compose.sh"; bash "$d/compose.sh" menu'
```

wget 入口（後續下載仍需 curl）：

```bash
bash -c 'set -eu; d=$(mktemp -d); trap '\''rm -rf -- "$d"'\'' EXIT; wget --https-only --timeout=30 --tries=3 -qO "$d/compose.sh" https://raw.githubusercontent.com/XiaoLong-Taiwan/XPayincus/main/XPayincus/deploy/compose/download.sh; bash -n "$d/compose.sh"; bash "$d/compose.sh" menu'
```

便利入口信任官方 HTTPS 與 main 維護權限；main 只提供入口，部署內容只下載正式 Release。`bash -n` 是語法檢查，不是來源驗證；需要獨立驗證時使用下方固定版本可信 SHA256 模式。不要 source 網路正文或 `curl | bash`。選單使用 `/dev/tty`，標準輸入被管線佔用時仍可操作；無終端時使用非互動 CLI。此入口只提供 Dashboard，頂層 Dashboard／Agent 選擇由統一入口整合。

選單使用 `[1]`、`[2]` 格式：[1] 查看狀態及啟動／停止／重啟／強制停止子選單、[2] 更新面板、[3] 安裝新面板 → [1] Compose／[2] 宿主機、[4] 重新拉取鏡像（不停止或啟動服務）、[5] 匯入資料、[6] 查看日誌、[7] 匯出資料、[8] 移動佈署目錄、[9] 保留資料重建容器、[0] 退出腳本。Compose 安裝會在下載最新 bundle 後自動設定並啟動。無參數 `bash download.sh`／`menu` 使用啟動時的工作目錄作候選；可明確傳入 `menu /srv/incudal-panel`。已安裝的 `bash panel.sh menu` 使用自身部署目錄。以 bash 執行，不 source 腳本。

[8] 會要求輸入新的絕對路徑與 MOVE 確認，全程持有操作鎖，先匯出資料庫，再停止容器、搬移完整部署並從新位置啟動。目標父目錄須存在、目標不可已存在，且限同一檔案系統以原子更名搬移；拒絕巢狀目標、掛載點、絕對或越界符號連結，以及設定中含來源絕對路徑的部署。部署內的相對連結、資料、密鑰、憑證與備份一併保留。搬移後啟動失敗時資料保留於新路徑，請從新位置查看狀態與日誌；外部代理、服務單元或備份排程若引用舊路徑，須自行更新。

更新前檢查候選內的 panel.sh、compose.yaml、可用的 docker-compose.yml 與非空 .env，支援指向部署內 `.bootstrap/` 的入口連結；拒絕越界腳本、群組／其他人可寫或非目前帳號／root 擁有的檔案。這是結構與權限檢查，不是來源簽章：執行本機入口前仍要求輸入 yes 確認為自己管理且信任的部署。無效時詢問既有絕對路徑，不自動 mkdir；新安裝則先顯示目錄並要求 yes 才允許建立。

Docker 前置檢查確認 binary、Compose plugin >=2.20.0 與 daemon 可用；可獨立呼叫 `bash download.sh docker-check`。缺少元件時提供 Docker 官方 Debian／Ubuntu apt 文件與套件指令，使用者自行確認 repository／服務／權限，不執行 curl|sh、不 purge Docker。重裝是面板容器重建：[9] 輸入 rebuild 確認，或 `bash panel.sh up pull --force-recreate`。仍先完成全部 pull 才停舊服務，不重新初始化、不刪 volume／DB／secrets；有短暫停機，應先備份，不承諾 migration 自動回滾。

供頂層 Dashboard 短入口整合：以子程序執行 `bash download.sh menu [DIRECTORY]` 並保留原 cwd；使用者選宿主機時回傳退出碼 20，由上層轉至 `dashboard.sh --host-install`，不得再次呼叫同一 Compose 選單。一般離開為 0。本子入口不尋找或執行未驗證的 dashboard.sh，不改 Agent 或根入口。單獨精靈為 `bash panel.sh wizard`；舊 setup／init 維持只初始化、不啟動。

安裝精靈依序詢問：入口（1 Nginx／2 Cloudflare Tunnel／3 external）、前站 HTTPS origin、管理站 HTTPS origin、管理員電子郵件、管理員密碼及確認。公開網址沿用 HTTPS 政策，不接受 HTTP、路徑、尾斜線或同 hostname；密碼沿用 8–128 字元且需大寫、小寫與數字的政策。管理員帳號為 `admin`，輸入的郵件用於 ADMIN_EMAIL。密碼與 Tunnel token 從 `/dev/tty` 隱藏讀取，不放進 argv、環境變數或輸出；不要開啟終端錄製或輸入記錄。

Nginx 接著詢問兩個網域各自的 fullchain.pem 與 privkey.pem 來源路徑。可重複輸入同一組涵蓋兩個網域的 wildcard 憑證路徑；精靈使用 OpenSSL 檢查有效期、系統信任鏈、hostname 及公私鑰配對，只接受不需互動解密的私鑰，驗證通過才複製至 `tls/user/`、`tls/admin/`。不自動簽發、不產生假 TLS，也不把自簽憑證直接當成受信任；私有 CA 須事先安全安裝到作業系統信任庫。使用者須自行完成 DNS、443 入口及憑證續期。

Cloudflare 接著隱藏詢問 Tunnel token，寫入 `secrets/cloudflare_tunnel_token`，權限 0600。請在 Cloudflare 設定前站與管理站兩個公開 hostname，兩者 Service 均為 `http://tunnel-origin:80`，保留原 Host header；Cloudflare 提供公開 TLS。精靈不呼叫 Cloudflare 管理 API，不要求 API key、不自動建立 DNS／Tunnel 規則。external 模式則由使用者既有代理終止 TLS。

所有輸入與 TLS 驗證完成後才寫入 `.env`、獨立 secrets 及所需 TLS，檔案權限 0600、私密目錄 0700。若已有 `.env`、`secrets`、`tls`、`data`、`certs`、`config` 或 `backups`，直接拒絕覆蓋；設定失敗／取消不執行 up，暫存私密資料會清理。成功寫入後自動執行 `up pull`，只有健康檢查通過才顯示精靈完成。pull／啟動失敗保留設定，修正後以選單 [1] → [1] 或 `bash panel.sh up pull` 重試；不要重新初始化。容器健康不等同 DNS、外網 TLS 或登入驗收，也不承諾 DB 自動回滾。

非互動最新安裝為 `bash download.sh install /srv/incudal-panel latest`，可省略 latest。自動取得同 repository 的 SHA256SUMS，無須手動找 SHA，但這不是獨立簽章。只下載 `xpayincus-compose-vX.Y.Z.tar.gz` 最小 bundle；缺少資產會停止，不退回完整來源包、不 git clone。bundle 格式為根 `VERSION` 與 `XPayincus/deploy/compose/` 固定部署檔，必須有 `update.py`、`compose.release.yaml`；不得含 client/server 來源或私人資料。此資產須由官方打包／發布流程交付，本機入口修改不代表線上已存在。

固定版本可信 SHA256 模式仍相容；請從獨立可信管道確認入口與 archive 的預期值，不能下載後自行計算就視為驗證：

```bash
VERSION=v1.0.12
BOOTSTRAP_SHA256='填入可信的入口腳本64位小寫SHA256'
ARCHIVE_SHA256='填入可信的Dashboard封裝64位小寫SHA256'
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --output "xpayincus-compose-$VERSION.sh" \
  "https://github.com/XiaoLong-Taiwan/XPayincus/releases/download/$VERSION/xpayincus-compose-$VERSION.sh"
printf '%s  %s\n' "$BOOTSTRAP_SHA256" "xpayincus-compose-$VERSION.sh" | sha256sum --check --status && \
  bash "xpayincus-compose-$VERSION.sh" install /srv/incudal-panel "$VERSION" "$ARCHIVE_SHA256"
```

此處使用 v1.0.12 發行目標範例；下載前確認該版本正式 Release、資產及映像均已發布。v1.0.5 工具不具備自主更新功能，舊部署須先核對工具版本。確認下載與校驗成功後初始化：

```bash
cd /srv/incudal-panel
bash panel.sh setup https://pay.example.org https://admin.example.org admin@example.org nginx
```

`ARCHIVE_SHA256` 對應 `xpayincus-dashboard-$VERSION-compose.tar.gz`，不是 GitHub 自動產生的 Source code archive；版本僅接受正式 `vX.Y.Z`。`setup` 同 `init`，只建立初始設定；完成憑證／Tunnel 設定後執行 `bash panel.sh up`。包內 `compose.release.yaml` 必須使用相同版本 API／web 映像，必須已有對應 Docker workflow 產物。入口與封裝均須經正式整合及 Release 發布後才可從上述 URL 下載；本機修改不代表線上資產已存在。

下載先驗證整包 SHA256，再核對包內根 `VERSION`、必要檔案、映像 override 與 Bash 語法。只寫入固定部署檔案清單，拒絕 traversal、重複路徑、符號／硬連結及特殊檔案，並限制下載及解壓大小。完整成功後，使用同一檔案系統內的 rename 原子切換 `.bootstrap/current`；根入口連結均固定指向該指標。版本、資產名與 checksum 記錄於 `.bootstrap/current/receipt.json`，舊 release 保留供人工檢查，不自動清理。

舊 `install DIRECTORY VERSION SHA256` 仍下載完整 Dashboard archive，但只取出部署檔；選單／latest 使用最小 bundle。可信 SHA 的最小 bundle 介面為 `install-bundle DIRECTORY VERSION SHA256`，顯式 bootstrap 檔案更新為 `update-bundle DIRECTORY VERSION SHA256`。不安裝 build source 或 `.env.example`。`.env`、`secrets/`、`certs/`、`tls/`、`data/`、`backups/`、`config/`、本機 `source/` 都不在更新清單內。部署目錄須為可信、同一操作帳號獨占寫入的 Linux 目錄；請從根 `panel.sh` 連結操作，不從 `.bootstrap/` 內直接執行。SHA256 保護封裝內容；映像依版本標籤選取，須信任 GHCR 發布者不覆寫標籤。

宿主安全自主更新（需 Python 3.9 以上、Docker Buildx 及本版 `panel.sh`／`update.py`／`download.sh`）：

```bash
bash panel.sh update
```

無參數更新只向官方 GitHub Releases API 查詢一次 latest，核對非 draft／prerelease 的正式 `vX.Y.Z`，之後固定 tag 取得 `SHA256SUMS` 與目標最小 Compose bundle。核對舊部署時依 receipt 選擇該版本最小 bundle；舊手動／Dashboard 來源包部署仍需下載舊版來源包來比對。checksum 必須唯一且符合完整資產名稱，整包通過校驗才解析；不接受 URL／repository 覆蓋。信任官方 GitHub HTTPS 與 Release 發布權限，checksum 不是獨立簽章；需要獨立可信 checksum 時使用顯式介面。拒絕自動降版；同版允許重新部署。

下載失敗會顯示階段、移除 query 的 URL、HTTP 狀態與處理建議。403 只有在 `x-ratelimit-remaining: 0` 或 `Retry-After` 等證據存在時標示限流；一般 403 請檢查 repository 權限、組織 SSO、出口 IP 與代理政策，401 則檢查 token，404 檢查版本與資產是否已發布。限流時等待輸出的 reset／retry 時間後重試。DNS、TLS、逾時或本機寫入問題會提供 curl exit code；不列印回應正文、token 或 CDN 簽名 query。

需要 GitHub API 認證時，以安全編輯器將 token 存入部署目錄外、目前操作帳號持有且權限 600 的一般檔案，再指定檔案路徑；不要把 token 放進 `.env`、命令列或開啟 shell trace：

```bash
chmod 600 /srv/private/github-read-token
XPAYINCUS_GITHUB_TOKEN_FILE=/srv/private/github-read-token bash panel.sh update
```

公開 repository 可匿名讀取；需要 token 時僅給必要的讀取權限（fine-grained token 對該 repository 的 Contents read，並依組織要求授權 SSO）。token 透過 curl 標準輸入傳遞，只送到 `https://api.github.com:443`，不送到 github.com、GHCR 或資產 CDN；重新導向逐次驗證 HTTPS 與官方主機白名單，不沿用跨來源認證。GitHub API token 不會解決 GHCR 拉取權限，私有映像仍須另行安全登入 registry。

固定版本 `SHA256SUMS`／Dashboard archive 的 github.com 直連若回傳 403／404，會改查同一官方 repository、同一 tag 的 Release API，核對正式版本與唯一資產名稱後，從 API asset ID 下載。此替代路徑適用於 `update` 及顯式 `download.sh`，仍執行原 SHA256、VERSION、映像與 archive 安全檢查；不使用第三方鏡像、不在 latest API 失敗時猜版本、不跳過校驗。若兩個官方來源都被封鎖，修正網路或權限後重試。

整段持有同一操作鎖：下載並驗證目標與目前版本官方部署檔 → 比對本機 → 核對現有容器 → 驗證目標 Compose → 在 `backups/before-update-<隨機值>/` 保存原部署檔與 `panel.dump` → 切換部署檔 → 自動 `up`。備份失敗不切換、不停止容器；`up` 核對已切換的釘選版本 registry digest，與本機 RepoDigests 不一致才強制拉取應用映像，另補齊其餘必要映像，成功後才 stop。不初始化、不改寫 `.env`、金鑰、憑證、資料、`source/` 或 project 名稱。切換前要求 `panel.dump` 為非空一般檔案，計算備份雜湊並將 `backupComplete`／`backupSha256` 寫入持久 journal；恢復啟動會核對備份路徑、符號連結限制及 dump 雜湊，未完成或不一致時拒絕。DB dump 是運行中一致性快照，與之後 migration 之間仍可能有新寫入；設定、密鑰與憑證須另行離機備份。

工具下載／校驗、目標 Compose 驗證或備份失敗時不切換部署檔；切換失敗不執行 up，保留備份並要求檢查入口。映像準備失敗時舊容器不先停止，但已切換的工具與備份保留，修正 registry 問題後可執行 `bash panel.sh up`。停止服務或啟動／健康檢查失敗時，會明示服務可能已停止或執行 migration；請查看 status／logs 並保留備份，不自動回滾資料庫。

舊手動部署可安全遷移納管：在原實際部署目錄執行 `panel.sh update`。目前版本官方 archive/checksum 必須仍可下載；既有管理檔逐位元組符合該版官方檔案，必要入口齊全且為一般檔案。容器須屬於同一 `incudal-panel`、同一實際部署目錄及標準 Compose 檔，DB／API 正在運行、每服務單一容器、DB 與 API 私人資料為原目錄標準 bind mounts。自訂入口、override、project 名稱、多副本、named volume、部署外掛載或衝突的 `COMPOSE_*` 一律拒絕，保留原資料與專案識別。成功後固定管理清單轉成 `.bootstrap/current` 連結，原部署檔保存在備份目錄；手動檔案轉連結不是跨檔案原子操作，中斷時須依備份修復，勿同時直接操作 Compose。

舊版腳本不會自行取得本功能；須先交付經驗證且與目前官方 Release 相符的工具。尚未發布的本機修改、私改檔案或缺少 `update.py` 的目標 Release 會拒絕，不能宣稱線上已可一鍵更新。

原顯式介面保留，僅準備 bootstrap 部署檔，不自動備份或啟動：

```bash
bash panel.sh export
bash panel.sh update "$TARGET_VERSION" "$TARGET_ARCHIVE_SHA256"
bash panel.sh up
```

`update VERSION SHA256` 與所有 CLI 共用操作鎖，只準備及切換檔案，不呼叫 Docker；下載、驗證或切換前失敗時保留原指標及運行中的服務。此介面成功不代表容器已切換。兩種更新模式在**開始重建容器或 migration 後，失敗不保證舊服務持續運行，也不自動回滾 DB**。請查看 `status`／`logs`，保留備份並按相容 schema 的還原計畫處理。此入口不判斷 schema 相容性，不可用於歷史版本受控遷移。

`TARGET_VERSION` 為已發布的固定正式版本；`TARGET_ARCHIVE_SHA256` 為該版 Dashboard archive 的可信 checksum。可在部署目錄外執行已驗證的入口：`bash /trusted/download.sh update /srv/incudal-panel "$TARGET_VERSION" "$TARGET_ARCHIVE_SHA256"`。DB 備份之外，請另行安全備份 `.env`、secrets、憑證與其他私人資料。

首次 install（亦接受 download 別名）拒絕非空目錄；顯式 `download.sh update DIRECTORY VERSION SHA256` 僅接受 bootstrap 布局且所有管理入口仍為預期連結。舊手動部署只能透過 `panel.sh update` 完成標準比對及納管；自訂部署另行規劃遷移，勿直接刪除原資料或改 Compose project。首次失敗可能留下 `.state/`、`.bootstrap/` 或未啟用的 release；檢查後改用另一個空目錄重試。中斷時不自動清除舊 release。直接 `docker compose` 不受 CLI 操作鎖保護。

### 完整來源安裝

1. 在 Linux 安裝 Docker Engine 與 Compose v2.20.0 以上外掛。Debian／Ubuntu 的其他前置工具可用 `sudo apt-get install bash openssl util-linux coreutils tar findutils gawk` 安裝。按所選模式準備 DNS、憑證或 Tunnel，並規劃建置、DB、WAL 及備份空間。
2. 確認 `docker version`、`docker compose version` 可用。建立空的部署目錄，從完整倉庫或來源包執行安裝；省略目的地時安裝至目前目錄：

```bash
mkdir -p /srv/incudal-panel
cd /srv/incudal-panel
bash /srv/longshang-xpayincus/XPayincus/deploy/compose/panel.sh install
bash panel.sh init https://pay.example.org https://admin.example.org admin@example.org
```

也可在來源目錄執行 `bash deploy/compose/panel.sh install /srv/incudal-panel`，再進入目的地操作。目的地必須為空且位於來源樹之外；安裝會複製 workspace 清單、lockfile、完整前後端及部署建置來源至 `./source/`，並在目的地建立 `panel.sh`、Compose 設定與文件入口，排除依賴、建置產物及原部署私密資料。不需要保留原來源路徑。複製失敗時目的地可能留下部分檔案，請檢查並改用另一個空目錄重試。

以下命令以安裝後的部署目錄為工作目錄，`./` 指該目錄，無論從何處呼叫 `panel.sh`，資料仍定位在腳本旁。若直接使用倉庫模式，改用 `bash deploy/compose/panel.sh`，資料則在 `XPayincus/deploy/compose/`，原有 `../..` build context 保持可用。

| 部署目錄路徑 | 用途 |
| --- | --- |
| `./source/` | 完整可建置來源，含 `source/deploy/compose/Dockerfile` 及其專屬 ignore |
| `./.env`、`./secrets/` | 私有配置、五個應用 secret，以及 Cloudflare 模式額外的 token file |
| `./tls/user/`、`./tls/admin/` | 自搭 Nginx 的 fullchain.pem 與 privkey.pem，唯讀掛載，不複製進來源或映像 |
| `./data/postgres/` | PostgreSQL 16 資料與 WAL，bind mount |
| `./certs/` | 面板連線 Incus 的憑證及私鑰，bind mount |
| `./config/` | API 可寫設定目錄，bind mount |
| `./backups/` | 預設 DB 匯出及匯入前備份，API 僅唯讀掛載 |
| `./.state/` | CLI 操作鎖 |

`init` 不連線資料庫、不建立容器。它以 `umask 077` 建立 `.env`、私有 `secrets/` 目錄及各自獨立的 PostgreSQL、JWT、cookie、加密與管理員密碼，拒絕覆蓋既有配置。初始帳號為 `admin`；密碼位於 `./secrets/admin_password`，不會印到終端。請在可信環境以安全方式讀取並保存。若初始化中斷，先檢查已建立的配置，勿任意重新產生或替換既有密鑰。

3. 如需改用其他 loopback 埠，啟動前編輯 `./.env` 的 `USER_PORT`／`ADMIN_PORT`，並同步修改宿主代理 upstream。不要先複製 `.env.example`，否則 `init` 會拒絕覆蓋；該檔僅為欄位參考。
4. **有既有 DB 要還原時，此時先還原原密鑰與憑證，再執行匯入，勿先執行 `up`。** 已保存整套原 `.env`／`secrets/` 時，直接安全複製回部署目錄並跳過 `init`；若先用 `init` 產生新配置，必須在啟動前以原值取代 `secrets/encryption_key`，並依「密鑰、憑證」節保留其他 secret 與憑證。然後執行：

```bash
bash panel.sh import /srv/private-backups/panel.dump --confirm-replace-incudal
```

匯入命令會停止既有面板，只啟動 DB 及其相依的 Compose `init` 服務，等待 DB 健康後還原；不建置或啟動 API，不執行 Prisma migration。還原前自動備份可能僅含空 DB。匯入成功後面板仍停止，確認資料、密鑰與版本相容後再繼續。

5. 依下一節設定所選 HTTPS 入口，然後啟動面板：

```bash
bash panel.sh up
bash panel.sh status
```

`up`（同 `up pull`）先檢查五個 secret、Compose 設定與所選入口的憑證／token。沒有 `compose.release.yaml` 的手動／自訂部署直接執行 Compose `pull --policy always`，依目前設定解析並拉取所有啟用服務的 image，不要求 `update`、Python、Buildx 或完整建置來源，也不改寫私人設定。有官方 release 檔時沿用其正式版本 API／web 映像及既有驗證，透過 Buildx 取得 registry index digest；與本機 RepoDigests 相同時略過應用映像 pull，任一映像缺少或不同則對 api／user／admin 使用 `pull --policy always`。此官方模式的 DB、init 與所選入口映像另使用 `pull --policy missing` 補齊。兩種模式都在全部必要映像準備成功後才停止既有前端、API 與舊入口，並以 `--no-build --pull never` 啟動，避免停機後才下載或意外建置。digest 無法解析或 pull 失敗時不停止舊服務。`up` 不查詢 GitHub latest 或改寫 image 設定；自訂 tag 的拉取結果依 registry 為準，官方部署檔換版使用 `update`。`up build` 額外檢查完整來源，先建置 api／user／admin 並拉取其餘所需映像，全部成功後才停舊服務。Compose `init` 容器只初始化權限；API 保留憑證生成／驗證流程，驗證成功後執行 migration，再以 UID 1000 啟動單一 Node 程序。

```bash
bash panel.sh up pull
bash panel.sh up build
```

Compose 啟動等待最長 300 秒，包含 DB／API 健康檢查及兩套 Nginx 的 `/index.html` HTTP 檢查；這不代表已完成 TLS、登入或瀏覽器端驗收。Migration 失敗時前端不會重新開放；修正原因後再執行 `up`。Migration 可能修改資料，升級前請先匯出備份。超時或 unhealthy 不會自動回滾或停止整套服務，先查看 `status`、`logs init` 與 `logs api`，勿直接清除 `data/postgres/`。

### HTTPS 與容器網路

`init` 的第四個參數可選 `nginx`（預設）、`cloudflare` 或 `external`；它分別寫入 `.env` 的 `COMPOSE_PROFILES=nginx`、`COMPOSE_PROFILES=cloudflare` 或空值。也可初始化後編輯 `.env`。CLI 僅接受這三種值；`up` 映像準備完成後停止舊入口，再按所選 profile 啟動，`down` 會涵蓋兩種 profile。直接使用 Compose 切換模式時，須自行停止舊入口，避免舊服務留在運行中。

| 模式 | 啟動的選用服務 | 前置設定 |
| --- | --- | --- |
| `nginx` | `nginx` | 憑證置於 `./tls/user/`、`./tls/admin/`；公開 `${HTTPS_PORT:-443}` |
| `cloudflare` | `tunnel-origin`、`cloudflared` | token file 與 Cloudflare 公開 hostname 路由；不發布額外宿主埠 |
| 空值（`external`） | 無 | 自行管理宿主 Nginx，使用 loopback 3000／3001 |

自搭 Nginx 使用 `.env` 的兩個公開 hostname 分流，直接以 socket 來源覆寫 `X-Real-IP`。憑證簽發、續期由操作人員管理；更換憑證後重啟 `nginx`。若公開 origin 使用非預設 HTTPS 埠，將 `HTTPS_PORT` 設為相符埠。預設不開啟 HTTP 80。若使用既有宿主 Nginx，選 `external` 以免爭用 443。

Cloudflare 模式可使用任意符合 `https://hostname[:port]` 格式的自有網域，並將相同 hostname 設為 Cloudflare Tunnel Public Hostname。網域在前端 runtime config、容器入口 Nginx 的 server name 與 API CORS 設定中於容器啟動時套用；不用改 Dockerfile 或重建 image。初次設定範例：

```bash
bash panel.sh init https://pay.example.org https://admin.example.org admin@example.org cloudflare
```

以安全編輯器建立 `./secrets/cloudflare_tunnel_token`，只寫入 token 本身，再執行 `chmod 600 ./secrets/cloudflare_tunnel_token`。CLI 不接受 token 引數、不讀出或列印其內容；Compose 使用 file secret 掛入 `/run/secrets/cloudflare_tunnel_token`，cloudflared 透過 `--token-file` 讀取。不要把 token 放入 `.env`、shell history 或日誌；不要開啟 shell trace 或 cloudflared debug。cloudflared 以 root 讀取 600 file secret，但 drop 全部 capabilities、禁止新增權限並使用唯讀 root filesystem。此映像使用 `latest`，正式部署可由操作人員鎖定已驗證 digest。

在 Cloudflare 的 remotely-managed tunnel 設定兩筆 Public Hostname，必須與 `.env` 的 `FRONTEND_URL`、`ADMIN_FRONTEND_URL` hostname 完全一致；兩者的 Service 都設為 `http://tunnel-origin:80`，保留原始 Host，不設定共同的 HTTP Host Header override；啟用公開 HTTPS 轉址及 WebSocket。不可指向 API。`tunnel-origin` 無宿主 ports，只在容器網路接收 cloudflared，依 hostname 分流至兩前端並使用 `CF-Connecting-IP` 覆寫來源 IP；不要將這個入口發布至不可信網路。首次連線、DNS／TLS 與來源 IP 仍需在目標環境驗收。

Compose 的 DB 與 API 不發布宿主機埠；DB 使用 internal network，API 另有對外網路以連線既有宿主機及第三方服務。只有雙前端 HTTP 埠發布至 loopback。Docker 網路及防火牆必須允許 API 到既有 Incus／Agent 相關端點，宿主機端點不可填容器內的 `127.0.0.1`。

使用自訂／外部 Nginx 時，`init` 選 `external`，`.env` 中的 `FRONTEND_URL` 與 `ADMIN_FRONTEND_URL` 可設定為任意不同 HTTPS hostname（可含有效 port，不含路徑或尾斜線），並須與 DNS、TLS 憑證及 Nginx `server_name` 相符。前端容器只綁定 loopback，預設使用者端 `127.0.0.1:3000`、管理端 `127.0.0.1:3001`；自訂埠時同步設定 `.env` 的 `USER_PORT`／`ADMIN_PORT` 與 Nginx upstream。將 [https-proxy.conf.example](./https-proxy.conf.example) 的網域、憑證路徑及 upstream 埠替換後，整合至宿主機 Nginx。該檔案放在 Nginx `http` context；TLS 憑證簽發、續期、80→443 轉址及正式網域限制由宿主機管理。管理端可再加 VPN 或來源 IP 限制。必須由最外層可信代理**覆寫** `Host`、`X-Real-IP`、`X-Forwarded-For` 與 `X-Forwarded-Proto`；容器 Nginx 會轉送可信的 `X-Real-IP`，不能讓客戶端自行提供該 header，避免偽造付款白名單或限流所使用的 IP。若前方還有 CDN，先在宿主機按 CDN 官方網段設定 real-IP 信任範圍，不能直接信任任意來源 header。

Nginx 範例的 upstream 為 HTTP，不能改成容器的 HTTPS 埠；若公開 origin 使用非預設埠，也須同步調整宿主 `listen`。在部署主機完成設定後執行 `sudo nginx -t`，確認成功再執行 `sudo systemctl reload nginx`。這兩個命令由操作人員在目標主機執行，CLI 不修改宿主代理。

本配置固定 HTTPS cookies、host-only cookies 與同源 `/api`，包含 WebSocket upgrade；不要直接透過 HTTP localhost 登入。雙前端啟動時以驗證過的 HTTPS origin 原子產生 `runtime-config.js`，在入口模組之前載入；僅包含公開的 apiBaseUrl（固定 `/api`）、customerBaseUrl、adminBaseUrl。API clients、WebSocket URL 與管理端客戶連結共用設定；原生／開發環境保留 VITE 變數回退。此檔使用 `Cache-Control: no-store`，Service Worker 不快取。變更網域時編輯 `.env` 的兩個公開 URL，並同步更新 DNS、代理 hostname、TLS 及 Cloudflare Public Hostname（若使用）；接著執行 `bash panel.sh up` 重新建立容器即可，**不需重建 image**。該命令會重建前端 runtime config 和入口 Nginx hostname，不會重建程式碼映像。

### 設定欄位與日常操作

| `.env` 欄位 | 說明 |
| --- | --- |
| `FRONTEND_URL`、`ADMIN_FRONTEND_URL` | 不同的 HTTPS origin，無路徑或尾斜線；用於 CORS、公開 URL 及前端執行期連結 |
| `ADMIN_EMAIL` | 首次建立 `admin` 的電子郵件；改值不會覆蓋既有管理員資料 |
| `USER_PORT`、`ADMIN_PORT` | 不同且未占用的宿主 loopback TCP 埠，預設 3000／3001 |
| `COMPOSE_PROFILES` | `nginx`、`cloudflare` 或空值；不要同時啟用兩種入口 |
| `COMPOSE_FILE` | 預設 `docker-compose.yml`；發行 override 存在時為 `compose.yaml:compose.release.yaml`（Linux） |
| `BUILD_CONTEXT` | 僅 build 模式使用；倉庫模式 `../..`、安裝模式 `./source`，由 init 自動填入 |
| `HTTPS_PORT` | 自搭 Nginx 對外 HTTPS 埠，預設 443 |
| `INCUDAL_RELEASE_REPOSITORY`、`INCUDAL_AGENT_RELEASE_REPOSITORY` | 可選的 Agent 資產來源 `owner/repo`；依既有 Agent 來源解析規則使用，不啟用面板 OTA |

`.env` 只供 Compose 插值，不會整份注入 API。額外 API 變數須明確加入部署設定；密碼與金鑰仍放 `secrets/`。避免在執行 shell 預先匯出同名變數，因 shell 的值優先於 `--env-file`。API 的 root entrypoint 只負責載入 secret、設定憑證目錄權限，再交由 UID 1000 執行 migration 與 Node；不要直接改成 `user: node`，否則無法讀取私有 file secrets 或修正 volume 權限。

```bash
bash panel.sh status
bash panel.sh logs
bash panel.sh logs init
bash panel.sh logs api
bash panel.sh down
```

`status` 包含已退出的容器，`logs` 顯示全部或指定服務最近 100 行且不持續追蹤。分享日誌前先移除敏感資料。`down` 保留部署目錄內的 bind mount 資料；不要刪除資料目錄，也不要使用 `docker compose down -v`，仍待遷移的舊 named volumes 可能因此被刪除。CLI 固定 project 名稱及 Compose 路徑，可從其他目錄使用腳本絕對路徑執行。部署與資料庫操作使用同一把非阻塞鎖；doctor、migration-plan 與預設 recover 為唯讀診斷，不建立鎖或狀態目錄，診斷期間狀態仍可能變動。直接呼叫 Docker 或其他專案副本不受這把鎖保護。

初始化後，在部署目錄可直接使用 Compose；`.env` 的 `COMPOSE_FILE` 與 `BUILD_CONTEXT` 已指向相同來源：

```bash
docker compose --profile nginx --profile cloudflare ps --all
docker compose up -d --no-build --pull never --wait --wait-timeout 300
```

建議使用 `panel.sh up`，其包含 secret／憑證檢查、互斥 profile 限制及停止舊入口。直接 Compose 不提供 CLI 操作鎖與這些前置保護。從舊配置升級時保留原 `.env`／secrets，補上 `COMPOSE_PROFILES`、`COMPOSE_FILE` 與 `BUILD_CONTEXT`；未設定 profile 時維持原有宿主代理模式。既有 USER_PORT／ADMIN_PORT 值繼續生效，不會自動改寫。

### 部署驗收與排查

以下命令供操作人員在目標 Linux 主機部署後執行：

```bash
curl --fail --silent --show-error https://pay.example.org/api/health
curl --fail --silent --show-error https://admin.example.org/api/health
```

再以瀏覽器確認兩端頁面、管理員登入與 WebSocket 終端；檢查使用者端不載入管理端入口，並確認 API 可連到目標 Incus。付款回呼與來源 IP 白名單須按實際付款來源設定，不可為了通過驗收關閉白名單。

| 現象 | 排查方向 |
| --- | --- |
| `init` 拒絕覆蓋 | 檢查是否已有 `.env`／`secrets/`，既有部署保留原檔，不重新初始化 |
| build 缺檔或 lockfile 不符 | 使用完整原始碼及同版本 lockfile，保留 `Dockerfile.dockerignore`；檢查 registry／Prisma 下載連線 |
| API restart／migration 錯誤 | `panel.sh logs api`、`logs db`、`logs init`；確認 DB 密碼與既有資料相符及完整 migration 歷史，不跳過 migration |
| 健康檢查超時 | `status` 查看含退出容器的狀態；Nginx 看 `logs user`／`logs admin`，API 看 migration 及啟動訊息 |
| HTTPS 502／登入失敗 | 核對 upstream、DNS／憑證、origin 與 secure cookie，確認已重建容器及 runtime-config.js 是目前網址 |
| GHCR pull 失敗 | 確認 tag、架構、權限及 registry 連線；舊服務保留運行，可明確選擇 up build |
| Incus 連線或憑證失敗 | 檢查容器到宿主的可路由位址、防火牆、`certs/` 內容與 UID 1000 讀取權限 |

不要用 `prisma db push --accept-data-loss`、刪除 migration 紀錄或清除 volume 來繞過啟動錯誤。若已有 DB migration 失敗，須先備份並診斷該 migration，再按 Prisma 的既有資料庫修復流程處理。

## 同版本操作能力（incudal-operations-v1）

最小 Compose bundle 同時交付 `operations.py`、`update.py` 與本指引；它們由同一版本 archive 的 SHA256 核驗。能力包含唯讀 doctor、舊宿主 migration plan、更新 plan、持久 journal 及中斷恢復。最小包沒有應用 schema、migration 原始碼或舊宿主 exporter；schema 比對須另外取得目標同版本完整來源或官方 API image，exporter 隨原生 Panel／Dashboard 來源包交付。

```bash
bash panel.sh doctor
bash panel.sh doctor --json
python3 operations.py doctor --base /opt/incudal --mode native --env-file /opt/incudal/.env --proxy external --json
bash panel.sh update-plan
bash panel.sh recover --json
bash panel.sh migration-plan /srv/private/legacy-export --target-schema /srv/target/server/prisma/schema.prisma --json
```

Doctor 僅使用 Python 3 標準函式庫，不需要 pnpm；Compose 模式另外需要 Docker Compose，TLS 配對需 OpenSSL，原生 ledger 與遷移 archive 檢查需 PostgreSQL client。接受 `docker-compose.yml`、`compose.yaml`、`compose.yaml:compose.release.yaml` 三種官方入口；存在 release override 時採後兩檔合併，避免 include 重複服務。它核對雙 HTTPS origin／不同 hostname、代理 profile、網站 TLS 或 Tunnel token、單 API 容器與 Node 程序、唯讀 migration ledger 及兩個公開 `/api/health`。HTTPS probe 驗證公開信任鏈且拒絕 redirect。原生自訂程序管理器、外部代理內部設定與 migration 是否涵蓋目標版本仍需人工核對；ledger clean 不表示 schema 已相容。`--env-file` 應是實際生效設定的私有副本，不執行 shell 語法或插值。JSON 的 checks 逐項包含 pass／warn／fail；fail 回傳非零，warn 必須另行驗收，`ok=true` 不等於可上線。

`update-plan` 取得既有非阻塞鎖，下載並核驗固定正式版本、目前部署與容器、目標 Compose，再列出計畫；會建立鎖與暫存目錄，但不備份、不切換、不停服務，也不改 journal。一般 `update` 將進度原子寫入 `.state/update-journal.json` 並 fsync，記錄版本、artifact SHA256、備份路徑／雜湊、備份完成、切換及最後階段；舊完成 journal 留存於 `.state/update-*.json`。此檔不含 secret，但包含部署路徑，仍須私有保存。SIGINT／SIGTERM 記錄中斷；斷電／SIGKILL 可能留下 running，須結合操作鎖與容器狀態判斷。

更新中斷後先執行 `recover`、`doctor`、`status` 與 `logs api`。未完成 journal 會阻止新更新；僅在 `backupComplete=false` 時可執行 `bash panel.sh recover --retry-preflight`，保留舊 journal 後重做前置流程。目標已切換且備份／journal 雜湊、版本與 receipt 相符時，可人工確認 migration 狀態後執行 `bash panel.sh recover --resume-up`，取得同一把鎖並重跑 `up`。已備份但未完成切換、檔案有衝突或 receipt 不符時須依備份人工修復；助手拒絕猜測。任何恢復均不自動還原 DB，也不以程式退版取代 migration 修復。

Migration plan 只讀 export 目錄，核對 v1 manifest、COMPLETE／INCOMPLETE、inventory 大小及 SHA256、非空 DB／env／encryption_key、原 secret、Incus 配對必要性與 OpenSSL 配對、`pg_restore --list`、來源與目標 schema，列出不含值的 env 映射與隔離還原命令。新版 exporter 會擷取可取得的來源 schema／migration，缺少時保留警告。`exportComplete` 僅表示 manifest 記錄的匯出完整，不能證明金鑰確為來源有效值、跨資源快照一致或可切換；`switchReady` 保守維持 false，須在隔離 PostgreSQL 16 還原、比對 ledger／checksum、以原 encryption_key 驗證解密／登入／Incus 信任，停舊 API／worker 後重新匯出並人工驗收。網站 `tls/` 與 Incus `certs/` 為不同身分；不應重生原 Incus 私鑰來略過警告。助手不連正式 DB、不執行還原或切流。

## 更新與移機

更新前安全保存 `.env`、整個 `secrets/`、`certs/`、`config/` 並匯出 DB。`install` 不覆蓋既有部署；同一部署目錄的一般啟動或程式映像更新使用 `panel.sh up`，官方部署檔更新與手動部署納管使用 `panel.sh update`，它會先備份 DB／部署檔再切換。pull／build 及其餘映像準備全部成功後才停舊服務。同機更換部署目錄時須先停止舊部署，避免同名 project 仍掛載舊路徑；此情況應事先準備映像。

使用發行包更新時保留目標包附帶的 `compose.release.yaml`，不要從舊版本複製該檔，避免將新原始碼標成舊版映像。它不含私人設定，不需由 `init` 產生。

歷史面板 v1.5.9 遷移至統一版 v1.0.x（含 v1.0.1）須受控遷移，不自動降版。先另行授權、備份資料庫與設定，核對 schema、部署方式、updater 版本及回復方案，再於隔離環境驗證；不可改寫目前版本或利用 Git fallback 繞過降版守衛。release channel 不代表資料庫相容。

移機時先在新主機準備完整原始碼、原配置與憑證，停止舊主機所有 API／worker，再於新主機只啟動 DB，匯入可信備份；不要先啟動 API 對待還原資料庫執行 migration：

```bash
bash panel.sh import /srv/private-backups/panel.dump --confirm-replace-incudal
bash panel.sh up
```

此時自動產生的 before-import 備份可能僅含空 DB。新主機須事先以安全離線流程還原 `certs/` 與 `config/`，確認 UID 1000 可讀取憑證及私鑰，再啟動 API。完成 HTTPS 與功能驗收後切換對外流量；全程只能有一個 API 執行背景任務。程式降版不會回復 schema，須搭配相容的 DB 備份及原金鑰，不提供自動回滾。

### 舊 named volume 遷移至目前目錄

新版使用 `./data/postgres` 與 `./certs` bind mounts，**不會自動讀取**舊 `incudal-panel_postgres_data`／`incudal-panel_panel_certs` volumes。只保留 project 名稱不足以遷移資料；直接啟動新版會建立空 DB。先記錄舊容器的實際 mounts 與 volume 名稱，並保留舊版完整設定及密鑰。

建議採邏輯備份：在仍使用舊 Compose 的來源目錄停止前端、API／worker，保持舊 DB 運行，以舊版 `panel.sh export /absolute/path/panel.dump` 匯出；隨後以舊設定 `down`（不可加 `-v`），再安裝新版、還原原 `.env`／`secrets/`、複製憑證及設定，最後執行新版 `import`，成功後才 `up`。若舊 API 另有可寫檔案掛載，也需一併離線備份。

舊服務全部停止後，以下範例在新版部署目錄將舊憑證 volume 唯讀掛載並複製；先用 `docker volume inspect` 確認 volume 確實存在，以免拼錯名稱而掛到新空 volume。目的 `certs/` 必須為空，不覆蓋已有私鑰：

```bash
docker volume inspect incudal-panel_panel_certs
mkdir -m 700 certs
docker run --rm --network none --entrypoint sh \
  --mount type=volume,src=incudal-panel_panel_certs,dst=/from,readonly \
  --mount "type=bind,src=$PWD/certs,dst=/to" \
  postgres:16-bookworm -eu -c \
  'test -z "$(ls -A /to)"; cp -a /from/. /to/; chown -R 1000:1000 /to; find /to -type d -exec chmod 700 {} +; find /to -type f -exec chmod 600 {} +'
```

若選擇實體複製 PostgreSQL 資料，必須先正常停止舊 DB，使用 PostgreSQL 16 相容映像及空的 `./data/postgres/`，保留所有檔案的擁有者、權限與連結；可沿用上述唯讀來源複製方式，將來源改為實際舊 DB volume、目的改為 `data/postgres/`，但**不要執行憑證用的 UID 1000／chmod 指令**。完整複製後必須保留與該 DB 相符的原 `postgres_password`。不可複製仍運行中的 PGDATA、混用兩套資料目錄或直接跨 PostgreSQL 大版本。實體複製與邏輯匯入擇一；保留舊 volumes 與獨立備份，直到新版完成資料、登入、解密與 Incus 連線驗收後，再由操作人員決定是否清理。

## PostgreSQL 匯出

DB 必須已啟動。不帶路徑時自動建立 `./backups/` 並產生 `panel-<UTC>-<隨機值>.dump`；亦可指定尚不存在的絕對路徑，其父目錄須事先存在：

```bash
bash panel.sh export
bash panel.sh export /srv/private-backups/panel-2026-11-07.dump
```

使用 PostgreSQL 16 容器內的 `pg_dump --format=custom --no-owner --no-acl` 取得一致性快照，可在面板運行中匯出。密碼在容器內從 secret 讀入 `PGPASSWORD`，不放在 CLI 引數、主機環境檔或輸出中。二進位串流直接寫入同目錄私有暫存檔，只有成功且非空才以 hard link 原子建立目的檔，不覆蓋既有檔案；失敗或中斷會清除暫存。目的檔案系統必須支援 hard link。備份包含敏感資料但**沒有加密**，須另行加密、離機保存並設定保留政策；不要存放於公開下載目錄。

## PostgreSQL 匯入

只接受可信的 PostgreSQL custom／tar archive，不接受純 SQL。PostgreSQL archive 能包含可執行的資料庫物件，`pg_restore --list` 僅確認可讀格式，不是惡意內容檢測。還原工具以資料庫擁有者連線，禁止匯入不可信來源。

```bash
bash panel.sh import /srv/private-backups/panel-2026-11-07.dump --confirm-replace-incudal
```

操作流程：

1. 在 `./backups/` 的私有暫存目錄複製來源，檢查五個 secret 與 Compose 設定。
2. 停止使用者前端、管理端與 API，避免背景 worker 持續寫入。只以 `up ... db` 啟動 DB 及相依的 `init`，等待 DB 健康；不啟動 API／migration，再讀取 archive 清單確認格式。格式錯誤也維持停機。
3. 將當前資料庫匯出至 `./backups/before-import-<UTC>-<隨機值>.dump`。備份失敗則拒絕匯入。
4. 使用 `pg_restore --clean --if-exists --single-transaction --exit-on-error --no-owner --no-acl` 還原至固定的 `incudal` 資料庫；發生 SQL 錯誤時回滾該交易。
5. 無論成功或失敗，面板均維持停止，避免自動執行 migration 或排程。確認程式版本、密鑰與憑證後，手動執行 `up`。

目標必須是相容的同一套面板 schema 或空資料庫；`--clean` 只清理 archive 中對應的物件，並不保證刪除目標額外物件。不同 schema／跨版本降級可能因依賴衝突而失敗，此時面板保持停止。不要將這個命令視為任意資料庫的清空或跨大版本遷移工具。只支援此 Compose 管理的 PostgreSQL 16；不修改外部資料庫、不建立或覆蓋角色與 tablespace。

CLI 停止的範圍僅限本 Compose 面板；操作人員須另外停止外部寫入程式／既有 systemd 後端。還原需要容納來源副本、還原前備份、DB 資料與交易 WAL 的磁碟空間。中斷後先確認 Docker 內的還原程序已結束，再啟動或重試；主機端腳本中斷不能保證立即取消容器內程序。

## 密鑰、憑證與更新限制

- DB archive 不含 `.env`、`secrets/`、`certs/`、`config/`、Incus 實例資料、ZFS、RFW 或任何外部儲存檔案。請另外安全備份配置、密鑰及憑證，並離機保存。
- **必須保存原 `secrets/encryption_key` 的值**（舊 systemd 部署為 `ENCRYPTION_KEY`）：程式以其原字串雜湊成 AES 金鑰，重新產生、改字元或多加空白都無法解密舊 DB 的加密資料。DB dump 無法補回遺失的金鑰。移機時不要因重新 `init` 而使用新金鑰；應在 API 第一次啟動前放回原值，勿將舊 env 檔整行 `ENCRYPTION_KEY=...` 或引號當作 secret 內容。
- 同時保存原 `jwt_secret`、`cookie_secret`、`admin_password` 與 `.env`。JWT／cookie 密鑰變動會使既有登入失效；`admin_password` 僅供初始建立使用，匯入既有管理員後不會重設其 DB 密碼。保留五個原 secret 是標準移機方式，CLI 不會替匯入資料重加密或重設管理員。
- 面板對 Incus 使用的 `client.crt`／`client.key` 位於宿主 `./certs/`，掛入容器 `/opt/incudal/server/certs`。既有部署搬遷須保留原憑證及私鑰並確保 UID 1000 可讀；新憑證須依既有流程重新建立 Incus 信任，DB 還原不會自動恢復該信任。
- PostgreSQL 密碼採 hex 以安全組合連線 URL；既有 PGDATA／實體 volume 搬遷必須保留相符的原 `postgres_password`，修改 secret 不會更新角色密碼。若僅將邏輯 dump 匯入全新 DB，可使用新 `init` 產生的 DB 密碼，因 dump 不含角色密碼；這不影響仍須保留原 `encryption_key` 的要求。
- Compose 固定向 API 注入 `INCUDAL_CONTAINER_DEPLOYMENT: 'true'`，禁止容器呼叫宿主 systemd／sudo OTA 更新或回滾；不要移除或覆寫此旗標。`GET /api/admin/system-update/version` 保留版本查詢，`GET /api/admin/system-update/check` 保留目前版本與 release 資訊，但回傳 `repositoryAvailable: false` 及 `repositoryError` 說明容器不可 OTA 與備份後重建方式，管理權限欄位仍按既有規則判定。
- 通過既有管理權限檢查後，`POST /api/admin/system-update/start` 與 `POST /api/admin/system-update/tasks/:id/rollback` 會回傳 HTTP 409、`CONTAINER_OTA_UNSUPPORTED`，在建立／修改任務、建立日誌目錄或啟動 worker 之前拒絕。更新請先備份、選定部署版本，再執行 `bash deploy/compose/panel.sh up` 拉取映像並重建容器；來源建置使用 `up build`。不提供自動 migration 回滾。
- Docker 建置使用專屬 allowlist ignore，排除本地依賴、環境檔、憑證及備份；runtime 保留 Prisma CLI 與建置依賴以沿用現有 workspace，尚未進行映像精簡與供應鏈掃描。基底映像固定主要版本標籤但未鎖 digest。
- Docker 管理員及主機 root 能讀取 Compose file secrets 與容器環境；這些檔案不是外部 secrets manager。勿上傳 secrets、備份或展開後的含密鑰環境。

## CI 與實機驗收

GitHub CI 執行版本核對、面板型別檢查與守衛、前後端建置、Agent 測試與跨架構建置，以及 Compose 映像建置；結果以對應 commit 的 Actions 紀錄為準。CI 建置成功不代表目標環境已完成部署驗收。安裝、權限初始化、容器啟動、首次還原、實際匯出／匯入及舊 volume 遷移須在隔離 Linux 環境驗證，TLS、登入、付款回呼與 Incus 連線另按目標主機設定驗收。

## Incus 客戶端憑證故障修復

這裡的 `certs/client.crt`／`client.key` 是面板連線 Incus 的 mTLS 身分，與 Nginx／Cloudflare 的 `tls/` 網站憑證不同。原始 v1.0.2 Compose 僅初始化目錄與權限，未生成這組憑證；原生 `scripts/install-panel.sh` 才有生成步驟，因此全新 Compose 部署可能回報「面板证书文件读取失败」。

本次修正後，API entrypoint 僅在兩檔皆不存在（也不是符號連結）時，以 UID 1000 在掛載目錄的私有暫存目錄生成 RSA 4096／3650 天自簽配對，再以不覆寫的 hard link 建立正式檔案。既有完整配對保留原內容；只有一檔、空檔、無法讀取、格式損壞或不匹配時停止啟動，不補造或忽略半套。若中斷導致半套，須還原原配對。目錄設為 700、一般檔案設為 600 並歸 node 所有；隨後以 node 身分驗證讀取、私鑰配對及 TLS 載入，成功才執行 migration 與單一 API。掛載檔案系統須支援 hard link。

路由在既有 token／所有權檢查後驗證同一配對；明確設定 PANEL 路徑時必須同時提供兩項，穩定目錄若有任一檔案就不會逐檔回退混用 release 憑證。下載只輸出重新序列化的公開 X.509 憑證，不回傳私鑰或原始 crypto 錯誤；驗證失敗回傳 `PANEL_CERTIFICATE_INVALID` 及路徑、掛載、權限、還原配對與 Incus trust 指引。

### 現有 v1.0.2 不升版立即處理

在 Linux 主機的**實際 Compose 部署目錄**操作（具有 `.env`、`certs/` 與 `docker-compose.yml`），先確認並安全備份既有憑證。若是移機／還原或曾連線過節點，即使兩檔皆缺也應先找回舊配對，避免變更身分。只有一檔時請停止並從備份還原匹配的另一檔，勿刪掉剩餘檔案再生成。完整配對僅需修正 UID 1000 所有權及 700／600 權限；不要以 `chmod 777` 解決。

以下命令供**確認為首次部署，兩檔確實皆缺**時使用，沿用現有 API 映像的 OpenSSL，不啟動第二個後端、不執行 migration。可直接用於尚未包含本次修正的 v1.0.2：

```bash
docker compose stop api
docker compose run --rm --no-deps --user 0:0 --entrypoint sh api -eu -c '
set +x
umask 077
d=/opt/incudal/server/certs
mkdir -p "$d"
for f in "$d/client.crt" "$d/client.key"; do
  if [ -e "$f" ] || [ -L "$f" ]; then
    printf "%s\n" "Existing cert/key found; restore or validate the original pair instead." >&2
    exit 1
  fi
done
chown 1000:1000 "$d"
chmod 700 "$d"
t=$(gosu node mktemp -d "$d/.client-XXXXXX")
trap '\''rm -rf "$t"'\'' EXIT
trap '\''exit 1'\'' HUP INT TERM
gosu node openssl req -x509 -newkey rsa:4096 -nodes -days 3650 \
  -subj /CN=incudal-panel/O=XPayincus \
  -keyout "$t/client.key" -out "$t/client.crt" >/dev/null 2>&1
chmod 600 "$t/client.crt" "$t/client.key"
ln "$t/client.key" "$d/client.key"
ln "$t/client.crt" "$d/client.crt"
'
```

放回舊配對或生成完成後，先修正這兩檔的權限並以 API 使用者檢查可讀性、配對與 TLS 載入。以下驗證只顯示成功／失敗，不輸出私鑰；失敗時不要啟動 API，先檢查掛載與備份：

```bash
docker compose run --rm --no-deps --user 0:0 --entrypoint sh api -eu -c '
chown 1000:1000 /opt/incudal/server/certs /opt/incudal/server/certs/client.crt /opt/incudal/server/certs/client.key
chmod 700 /opt/incudal/server/certs
chmod 600 /opt/incudal/server/certs/client.crt /opt/incudal/server/certs/client.key
'
docker compose run --rm --no-deps --user 1000:1000 --entrypoint node api --input-type=module -e '
import { readFileSync, statSync } from "node:fs";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { createSecureContext } from "node:tls";
try {
  const c = process.env.PANEL_CRT_PATH, k = process.env.PANEL_KEY_PATH;
  if (!statSync(c).isFile() || !statSync(k).isFile() || (statSync(k).mode & 0o077)) throw new Error();
  const cert = readFileSync(c), key = readFileSync(k);
  if (!new X509Certificate(cert).checkPrivateKey(createPrivateKey({ key, passphrase: "" }))) throw new Error();
  createSecureContext({ cert, key });
  console.log("Incus client certificate pair OK");
} catch { console.error("Invalid or unreadable Incus client certificate pair; restore the original pair and check mount/permissions."); process.exit(1); }
'
```

驗證成功後執行 `docker compose up -d --no-deps api`。若保留原配對，既有 Incus trust 可繼續使用；若生成新配對，請在面板重新產生節點安裝／重裝命令，於真正的 Incus 宿主機執行匯入目前公開憑證，再回面板驗證。不要將 `client.key` 複製到 Incus 宿主機或貼進工單。網站憑證更新或 API 重啟不會自動修復 Incus trust。

相關守衛入口為 `pnpm --filter server test:host-install-script-guards`（包含生成條件、不覆寫、半套拒絕、配對檢查、公開憑證輸出與錯誤遮蔽的結構斷言），另需 `pnpm --filter server test:host-route-id-guards`、`pnpm --filter server type-check` 及 `sh -n deploy/compose/api-entrypoint.sh`。Linux 實機須覆蓋全新生成／重啟保留指紋、半套／空檔／錯配拒絕、node 權限及節點信任流程。本次依要求未執行本機測試，這些項目為待驗收項目。
