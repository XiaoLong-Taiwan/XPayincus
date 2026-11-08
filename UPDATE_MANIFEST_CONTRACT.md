# 更新 Manifest 契約

本契約適用於 Go Agent 自升級及原生面板 OTA；沿用現有下載、SHA-256、替換及原子部署流程。Compose 仍依原本重建流程更新。

## 格式與演進

| 欄位 | Agent manifest／heartbeat upgrade | 面板 OTA manifest |
| --- | --- | --- |
| `schemaVersion` | 新格式為整數 `1`；缺省接受既有格式 | 必須為整數 `1`，沿用既有規則 |
| `minimumUpdaterVersion` | 可選，嚴格 `vMAJOR.MINOR.PATCH` SemVer；與目前 Agent 比較 | 可選，與目前已安裝面板版本比較 |
| 平台／架構 | manifest 使用 `files.linux-amd64`、`files.linux-arm64`；schema 1 指令必帶 `platform`、`arch` | artifact 必須是 Linux amd64／arm64，執行時精確選取 |
| 檔案身份 | 檔名必須對應 manifest 版本、平台與 gzip；SHA-256 必填 | 檔名、版本、平台、URL 與 Release asset 精確對應 |
| `size` | 舊格式可省略；提供時必須為正整數並核對下載長度 | 舊格式可省略；提供時必須為正整數並核對 Release／下載長度 |

schema 1 可增加未知的選填欄位。改變必填欄位或語意時須使用新 schema；目前消費端會拒絕未知 schema，須先透過相容版本更新 updater。`minimumUpdaterVersion` 是消費更新的程式版本，不是目標版本，也不是資料庫相容保證。最低版本省略時保留既有行為；明確提供 null、錯誤型別或非法版本則拒絕。

## 拒絕行為

- Agent 拒絕未知 schema、低於最低版本、目標降版、錯誤平台／架構、無效 SHA-256 與大小不符。開發版等非 SemVer 目前版本須人工安裝正式版後再自動更新。
- 明確設定的本地 Agent manifest 無效時不改用 GitHub；heartbeat 回傳 `available: false` 與 `error`。有發布 manifest 的 Release 必須讀取並驗證該 manifest，失敗不重建舊格式來繞過限制。沒有 manifest 的歷史 Release 保留既有產生方式。
- 面板以 `ota.error` 保留拒絕原因，包括最新版無效時的資訊；`auto`／`artifact` worker 不再回退 Git。只有明確指定 `git` 模式才走既有來源建置。
- 新版拒絕邏輯無法追溯修改舊 Agent 的行為；需先把節點更新到含此契約的 updater，再依靠未來 manifest 的限制。

## 下載驗證

Agent 限制初始 URL 與每次重新導向都在已設定面板 origin；保留原有 HTTP 面板支援，正式環境應使用 HTTPS。下載上限沿用 64 MiB（可由 runner 限制），gzip 展開硬上限 64 MiB；先驗證壓縮檔 SHA-256 與宣告長度，再展開及替換。錯誤不重啟或替換現有 binary。

面板 Release 下載只接受 HTTPS GitHub 可信主機，每次重新導向重新驗證；token 只送到 GitHub API origin。下載逾時 120 秒，artifact 硬上限 2 GiB，超限中止，失敗移除暫存檔；大小與 SHA-256 通過後才交給既有 staging 檢查。Manifest 與資產由可信 Release／面板提供，SHA-256 不等於獨立數位簽章。

## 本地契約檢查

在 `XPayincus/server` 執行：

```powershell
node --import tsx scripts/test-update-manifest-contract.ts
node --import tsx scripts/test-system-update-guards.ts
node --import tsx scripts/test-agent-install-command-guards.ts
node node_modules/typescript/bin/tsc --noEmit
```

在 `XPayincus-Agent` 執行：

```powershell
go test ./internal/upgrade ./internal/panel
go vet ./internal/upgrade ./internal/panel
```

Linux 上另執行 `go test ./...`，並在隔離宿主驗證 heartbeat → 拒絕更新／合法下載 → systemd 重啟。單元測試使用本地 HTTP fixture，不執行正式更新、不改動生產。整體型別檢查、守衛、Linux 真機驗證是不同證據，不能互相替代。
