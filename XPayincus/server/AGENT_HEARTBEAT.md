# Agent heartbeat 與離線判定

Agent 路由（使用者／管理員狀態及升級前檢查）、營運統計和週期離線檢查共用 `src/lib/agent-status.ts`。

- 上報間隔取自 `lastReport.metrics.heartbeatIntervalSeconds`，接受整數或整數字串，缺省／無效值沿用 30 秒，限制為 5～3600 秒。
- 新鮮度門檻為 `max(間隔 × 3, 120)` 秒；恰好到達門檻仍在線，超過才離線。60 秒上報間隔的門檻為 180 秒。
- 僅對啟用且資料庫狀態為 `online` 的 Agent 推導離線；沒有 `lastSeenAt` 亦視為離線。既有非 online 狀態及停用記錄保留；統計排除停用記錄。
- `startStatusScheduler` 既有每分鐘排程執行 Agent 離線檢查，獨立於實例同步的耗時及空清單。沿用單一 Node 部署，不新增程序或計時器。
- 離線檢查有程序內防重入且失敗後釋放。寫入以 Agent 身分、啟用狀態、online 狀態、掃描時的 `lastSeenAt` 與 `updatedAt` 作條件；新 heartbeat、停用或憑據輪換可阻止過期掃描覆寫。已離線記錄不會反覆更新。
- heartbeat 僅更新仍啟用且時間不倒退的同一 Agent；拒絕被取代或停用的寫入時回傳 HTTP 409／`AGENT_HEARTBEAT_REJECTED`。有效 heartbeat 可讓離線 Agent 回到 online。

本功能只更新 Agent 狀態，不變更 Host 狀態、Host 購買／交付政策、安裝 token 或憑據簽發流程，亦不新增離線通知。

本地驗證：在 `XPayincus/` 執行 `pnpm --filter server test:agent-status-guards`、`pnpm --filter server test:scheduler-startup-idempotency`、`pnpm --filter server test:commercial-operations-overview-guards` 與 `pnpm --filter server type-check`。新守衛以可控時間及模擬資料存取驗證門檻、統計一致性、重複轉換、競態及防重入，不需要資料庫。

實機驗收須在獲授權的測試環境驗證簽名 heartbeat、停報超時落庫、恢復上報和管理員停用；本地守衛不代表生產環境驗證。
