# Agent 出站管理隧道 v1

Agent 主動連線 `wss://<Panel origin>/api/agent/tunnel`，子協定為 `xpayincus-tunnel-v1`。Panel 必須使用有效 HTTPS 憑證，反向代理必須允許 WebSocket Upgrade 與長連線。Panel 不連線宿主 Incus 管理埠。

## 認證與路由

Handshake 重用 heartbeat 的 `x-incudal-*` HMAC headers；簽名方法為 GET、路徑為 `/api/agent/tunnel`、body hash 為空 body 的 SHA256。timestamp 必須有效，nonce 只能使用一次，Agent 必須啟用。拒絕 Origin header。每個 host 僅一條連線；輪替憑證立即關閉，停用最多等待 15 秒重新驗證。Server 為單一 Node 程序，連線 registry 不跨程序共享。

Server 使用 `getAgentTunnel(hostId).request(target, method, path, body?, headers?, timeout?, signal?)`；既有 Undici 呼叫使用 `AgentTunnelDispatcher`。IncusClient 建議提供 `hostId`，舊呼叫只在 URL 能唯一對應 DB host 時相容，URL 不作為網路目的地。

## 固定本機目的地

| target | 目的地 | 路徑 |
| --- | --- | --- |
| incus | Unix socket `/var/lib/incus/unix.socket` | `/1.0`、`/1.0/...` |

不接受任意 URL、代理目的地、宿主 shell frame 或 redirect。這是受信任 Panel 的管理 transport，Incus API 仍可執行既有實例 exec 操作；它不是限制實例管理能力的 sandbox。Agent 必須具備 socket 權限。

## Frame 與限制

所有 frame 為 JSON text。`hello` 帶 `version: 1`。`request` 帶 UUID `id`、`target`、`method`、相對 `path`、base64 `body`、`headers`、毫秒 `timeout`。`response` 帶相同 `id`、HTTP `status`、base64 `body`、允許的回應 headers，或 `error`。`cancel` 為 best effort 取消，不能回滾已完成的寫入。

只允許 GET/POST/PUT/PATCH/DELETE/HEAD；請求 headers 只允許 content-type、x-incus-name、x-incus-pool，回應只保留 content-type。請求與回應 body 各最多 512 KiB，frame 最多 768 KiB，header value 最多 4096 字元，path 最多 8192 字元。HTTP timeout 最多 120 秒；長操作應取得 operation ID 後以 GET 輪詢。

每個 host 同時最多 8 個 HTTP/WS 工作，每條終端 data/control WS 各占一個名額；Server 最多 4096 條 Agent 連線。Server 發送 buffer 超過兩個最大 frame 時關閉連線；Agent 寫入 timeout 為 10 秒。每條連線記錄最多 100000 個已使用 request ID，達上限後輪替連線。

`ws-open` 僅允許 Incus `/1.0/operations/<id>/websocket?secret=<secret>`，成功回 `ws-opened`；`ws-data` 使用 base64 body 與 binary flag，單訊息最多 64 KiB；`ws-close` 關閉 stream。不支援任意 WebSocket endpoint、Incus events 或通用 TCP tunnel。

雙方每 25 秒 heartbeat。Agent reconnect 使用指數退避，基底 1 至 30 秒加上同範圍 jitter，實際最大等待接近 60 秒。重連只恢復 transport，不重送任何 request。終端後端斷線即關閉，需使用者重新開啟。

## 結果與功能限制

送出後 timeout、取消、斷線或本機讀取失敗可能回報 `AgentTunnelError.outcomeUnknown`。呼叫端不得因此自動重播寫入，應查詢既有 operation 或實際資源狀態。transport 本身不重試寫入。

## 有界 HTTP 串流

`getAgentTunnel(hostId).requestStream(target, method, path, source?, headers?, signal?)` 與 `IncusClient.stream()` 回傳 HTTP 狀態、headers 與 Node Readable。來源為 AsyncIterable；Node Readable 取消時會 destroy 來源。Undici dispatcher 的 async iterable request body 自動使用此路徑。備份匯出、restore、maintenance 搬遷使用串流；`readFile()` 走串流但字串便利方法最多 16 MiB，大檔使用 `stream()`。

`http-open` 開啟工作，`http-upload` 帶從 0 開始的 seq 與最多 64 KiB base64 body。本機 HTTP writer 接收後回 `http-ack`；收到 ACK 前不得送下一塊。`http-upload-end` 帶下一個 seq 結束 request body。Agent 使用 io.Pipe，沒有整份 request buffering。

`http-head` 回傳 status/headers；消費端需要資料時發送 `http-credit`（下一個 seq），Agent 才讀取最多 64 KiB 並送 `http-data`。`http-end` 帶下一個 seq 表示 EOF，`http-error` 為失敗。每方向最多一個 chunk 在途，Node Readable highWaterMark 64 KiB，轉 Web stream 的 queue 也按位元組限制。每個 stream 共用 8 個工作的容量限制，整體期限 30 分鐘。沒有按總檔案大小限制，沒有整份備份 buffering。

串流 headers 額外允許 x-incus-uid/gid/mode/type/write；回應允許 content-type/content-length 與 x-incus-uid/gid/mode/type。固定本機目的地、method/path 驗證與 redirect 禁止同樣適用。

`ws-data` 使用逐訊息 `ws-ack`，Agent 等 ACK 才讀下一個本機訊息；Server outgoing queue 最多 256 KiB／64 訊息，10 秒未 ACK 關閉該 WS。瀏覽器輸出 buffer 上限為 256 KiB，超限關閉終端。這是有界停止／拒絕策略，不丟棄資料後繼續假裝成功。

Server 與 Agent 必須同步更新以支援新的 http-*／ws-ack frame，沒有舊 Agent 能力協商或自動降級。一般非串流 request/response 仍受 512 KiB 限制。沒有離線 queue、跨重連 resume 或實際宿主整合測試保證；斷線會顯式失敗，不重播 restore／檔案寫入。
