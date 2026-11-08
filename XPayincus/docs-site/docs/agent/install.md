# Agent 安装

Agent 运行在 Incus 宿主机上，用于上报宿主机资源、实例状态、流量数据，并配合面板完成交付链路。

## 宿主机系统

节点安装脚本推荐用于 Ubuntu 22.04+、Debian 12/13。Debian 11 保留兼容安装能力，但不建议作为新节点系统；Debian 10 及更低版本会被安装脚本拒绝。

## 面板证书信任

節點安裝腳本會把面板的 Incus 客戶端憑證加入宿主機 Incus trust。若面板重裝、遷移、災備還原或憑證輪替，舊 trust 可能造成 `not authorized`。支援 HMAC 的新版 Agent 可用既有節點認證取得並驗證新憑證，確認新連線成功後才移除舊指紋。

舊版 Agent 若不支援 HMAC 認證端點，面板不能安全地遠端證明新憑證，也不得盲目加入或移除 trust。先備份 `/etc/incus/` 與 Agent 設定，將面板升級至支援受認證信任端點的版本，再於原 Incus 宿主機重新執行新版節點管理腳本，讓 Agent 二進位更新；接著再次開啟腳本，完成受認證的信任更新。若舊 Agent 無法以原認證完成更新，從後台為該節點重新產生 Agent 安裝命令／一次性 token，在原宿主機執行以重新配對 Agent，完成信任後再於後台驗證節點。若 API 回報 `AGENT_AUTH_REQUIRED` 或 `AGENT_SIGNATURE_INVALID`，不得略過檢查或手動信任下載到的憑證，應走重新配對。這些步驟不會自動清除 Incus 容器、儲存池或節點資料；勿使用卸載／刪除資料選項，也不要手動刪除舊 trust 直到新憑證連線驗證成功。

面板憑證檢查於每次 API 啟動執行。`client.crt` 與 `client.key` 僅在兩檔都不存在時生成；只缺一檔、權限錯誤或配對不符時 API 會拒絕啟動。請從備份還原原配對，不要刪除半套檔案觸發新憑證生成。

## 发布配置

```dotenv
INCUDAL_RELEASE_REPOSITORY=owner/unified-repository
INCUDAL_AGENT_RELEASE_REPOSITORY=
INCUDAL_AGENT_RELEASE_TAG_PREFIX=
INCUDAL_AGENT_RELEASE_TOKEN=
```

上述設定放在面板端。舊 `INCUDAL_AGENT_RELEASE_REPOSITORY` 非空時優先於統一來源；前綴未設定時舊來源預設 `agent-`，統一來源預設空值，明確空值代表 `v*` tag。Compose 需透過 override 等方式將變數傳入 API 容器，僅寫入 Compose `.env` 不會自動注入。

遠端 Release 必須同時包含 amd64、arm64 未壓縮二進位；只有 `.gz`、manifest、tag 或 Actions artifact 不足。下載維持面板同源 `/api/agent/manifest.json` 與 `/api/agent/binary` 代理，私有 token 不下發宿主。Agent、Incus、RFW、ZFS 不在面板 Compose 內執行。

如果暫時沒有 GitHub Agent Release，也可以使用本地 release 目錄，放置舊格式 `manifest.json` 與兩架構 `.gz`；manifest 的 SHA256 對應壓縮檔：

```dotenv
INCUDAL_AGENT_RELEASE_DIR=/opt/incudal/agent-release
```

Agent 安装脚本会读取 `https://<panel>/api/agent/manifest.json`，并按当前系统架构选择 `linux-amd64` 或 `linux-arm64` 二进制。如果安装时报 `agent manifest does not contain linux-amd64 binary metadata`，通常表示安装脚本版本过旧，无法解析面板返回的单行 JSON manifest。请先更新面板到包含 Agent manifest 解析修复的版本，再重新复制后台生成的 Agent 安装命令。

如果后台日志显示安装 token 已被消费，但 Agent 仍然离线，并且 Nginx access log 中 `/api/agent/binary/...gz?v=<timestamp>` 返回 HTTP 400，说明旧安装脚本把二进制下载的缓存刷新参数写成了后端保留的 `v` 参数。请更新面板到包含 Agent 二进制下载参数修复的版本，确认公开 `install.sh` 中二进制 URL 使用 `cache_bust` 参数，然后重新复制后台生成的 Agent 安装命令。

## 资源与日志保护

Agent 默认每 60 秒上报一次，最小允许 30 秒。不要把上报间隔改成 5 秒这类高频值；实例较多时，每次心跳都会读取宿主机资源、运行中实例状态和流量计数，过高频率会增加 Incus API 和宿主机 CPU 压力。

当前 Agent 对采集做了以下保护：

- 单次最多上报 500 个实例。
- Incus 实例状态读取并发限制为 3。
- 非运行实例不再额外请求 `/state`。
- 成功心跳日志默认只记录首条和约每 10 分钟一条；失败日志默认首条和约每分钟一条。
- 安装脚本生成的 `incudal-agent.service` 包含 `CPUQuota=20%`、`MemoryMax=256M`、`TasksMax=128`、`LogRateLimitIntervalSec=30s` 和 `LogRateLimitBurst=120`。

如果节点曾经安装过旧 Agent，更新面板后需要重新复制后台生成的 Agent 安装命令并在宿主机执行一次。仅自动升级二进制不能改写旧 systemd service；重新执行安装命令会刷新二进制、配置和 systemd 资源/日志限制。

## 本地构建

從統一倉庫根目錄執行：

```bash
bash scripts/build-agent-release.sh
```

產品版本取自根 `VERSION`；`XPayincus-Agent/` 是 Go 原始碼目錄。根 release workflow 僅上傳 Actions artifacts，不會建立 GitHub Release。本次文件整理未執行測試、建置或宿主升級。
