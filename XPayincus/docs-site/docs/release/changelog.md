# 发布说明

发布文档分为两类：

- 本页：人工维护的发布策略、OTA 能力和生产验证说明。
- [系统版本更新日志](/release/version-log)：从 Git tag 和 commit 自动生成的版本记录。

統一發行以根 `VERSION` 與根 `RELEASE.md` 為準，目前發行目標為 **v1.0.18**；正式發布狀態以 GitHub Release 為準。

## v1.0.18 版本與文件同步（發行目標）

- 同步產品版本、Agent 預設版本、RFW 自家 crate／Cargo.lock、Compose 標籤及現行 fixture／文件至 v1.0.18。
- 現行最低 updater 記載為 `v1.0.3`，與 manifest 產生器一致；維持 30 件資產與 16 筆 SHA256SUMS，保留第三方依賴、歷史紀錄及宿主資產釘選。
- 本次僅編輯與靜態核對，保留既有工作區修改；未執行測試、型別檢查、建置、提交或發布。完整說明位於 `docs-site/release-notes/v1.0.18.md`。

以下舊版條目保留當時記載，不作為現行 updater 版本或發布狀態的依據。

## v1.0.17 信任刷新診斷（發行目標）

- 依階段提示信任刷新失敗原因與重試入口；Agent 已啟動但信任未完成時明確顯示狀態。
- HTTP 失敗只顯示狀態碼，API 日誌使用固定代碼，避免輸出密鑰、原始 HTTP 內容或例外文字。保留 HMAC 驗證及驗證成功後才移除舊信任。
- 同步版本與 Compose 標籤，維持 30 件資產及最低 updater `v0.0.3`。測試與建置由 GitHub Actions 執行，不部署生產；詳見 `docs-site/release-notes/v1.0.17.md`。

## v1.0.16 Agent heartbeat hash 修正（發行目標）

- API 對 Agent heartbeat 收到的原始 JSON bytes 驗證 body hash，避免解析後重新序列化造成跨語言數字或 Unicode 表示差異。
- 保留正常 JSON 解析流程，其他 API 路由不受影響。測試、建置與發布由 GitHub Actions 執行。

## v1.0.15 儲存池、監控與宿主入口（發行目標）

- 儲存池用途 `purpose` 正確寫入資料庫；先確認登記與關聯，僅用途變更不呼叫 Incus，容量或描述變更才更新 Incus。
- Agent 監控查詢使用共用 HTTP client，沿用統一認證、refresh 與錯誤處理，保留查詢參數、取消訊號及 30 秒逾時。
- `incudal`／`k` 捷徑修正統一倉庫路徑，下載與 Bash 檢查成功後才原子替換快取；失敗保留快取但不執行，保留其他既有 `k` 命令，提供 `--install-shortcuts` 修復入口。
- 宿主資訊頁移除維護計畫預檢／建立入口及相關目標／實例請求，保留既有計畫列表與後續操作。
- 同步產品版本、Compose 標籤、fixture 與現行文件，保留第三方與歷史版本、30 件資產集合及最低 updater `v0.0.3`。
- 本次只編輯與靜態核對，未執行測試、型別檢查或建置，未提交或發布，未重新查核遠端 Release；完整說明位於 `docs-site/release-notes/v1.0.15.md`。

## v1.0.14 安裝資訊與流程修正（歷史準備紀錄）

- 安裝指令、面板地址與 TOKEN 分欄顯示並獨立複製，指令不嵌入 TOKEN；提供複製成功／失敗提示與 Agent TOKEN 到期時間。
- 重新取得、關閉資訊、切換宿主及元件停用／卸載時清除前端安裝資訊，忽略過期回應；不撤銷已簽發 TOKEN，也不清除剪貼簿。
- 安裝先顯示摘要並確認，分別處理 UUID 與 `ait_` TOKEN；新裝準備 Incus／ZFS 後安裝 Agent，新池預設 ZFS、沿用既有 pool，重裝保留設定。確認後才更新宿主信任，Agent 安裝後刷新 Incus 信任。
- 改善步驟／終端選單與無色輸出，容量支援小數並區分 GB／GiB；舊含 TOKEN 的宿主腳本路由停用框架請求日誌，外部代理仍須遮蔽相關 URL。
- 同步產品版本、Compose 標籤、fixture 與現行文件；保留第三方及歷史版本、30 件資產集合與最低 updater `v0.0.3`。
- 2026-11-13 查核 GitHub v1.0.13 正式 Release，發布於 `2026-11-12T16:51:03Z`，非草稿、非預發行。本次僅編輯與靜態核對，未執行測試或建置，未提交或發布；完整說明位於 `docs-site/release-notes/v1.0.14.md`。

## v1.0.13 修正與版本同步

- ZFS loop 預設大小依 `/var/lib/incus` 所在磁碟剩餘空間的一半向下取整至 GiB，上限 10GiB；有效大小至少 1GiB，且不得超過剩餘空間的一半。
- 互動輸入格式錯誤、過小或超出容量時重新提示，空白採動態預設，輸入結束時停止；明確指定的無效 `INCUS_STORAGE_SIZE` 直接失敗。
- 自動 driver 且未指定大小時，若剩餘空間的一半不足 1GiB，改用 `dir`；明確指定 ZFS 或大小時報錯，不靜默切換。容量查詢失敗或資料無效時，在建立儲存池前停止。
- 同步三份 VERSION、四份 package.json、RFW 自家 crate 與 Cargo.lock、Agent 預設版本、Compose 標籤及 fixture／現行文件；完整集合維持 30 件，最低 updater 維持 `v0.0.3`。
- 完整說明位於 `docs-site/release-notes/v1.0.13.md`。

## v1.0.12 新增功能（已正式發布；歷史準備紀錄）

發布狀態依維護者於 2026-11-13 提供的資訊更新；以下保留當時準備與驗證紀錄。

- Agent schemaVersion 2 提供宿主／實例監控、PSI、實例排行及 RFW／ZFS 狀態事件，含 avg／min／max／count／coverage 與累計計數器差值／重設辨識；缺值不補零。最多保留 30 天，單一 Agent 樣本上限 8192 筆或 1536 KiB、事件上限 512 筆或 256 KiB，容量達限會提早截斷；兩端 state 須持久保存，API 仍限單一 Node 程序。
- 商品網路探測保存瀏覽器 HTTPS 與人工本機 TCP／ICMP 紀錄，全部 `verified: false`；人工提交須承認未驗證，Agent 不執行遠端探測。最多保留 30 天，每位 owner 100 筆、全域 10000 筆；須交付 `20261111050000_network_probe_records` migration。
- Compose 更新保存部署檔及非空 DB dump、計算備份雜湊並寫入持久 journal，恢復啟動核對備份完整性；失敗保留備份，不自動回滾 DB。運行中快照與 migration 間仍可能有新寫入，密鑰／設定／憑證須另行離機備份。

依維護者核實的 v1.0.11 正式發布 run `42940308896`、已完成的公開發行前審查與 receipt 授權準備本版。完整範圍與限制見根 `RELEASE.md`；本輪僅編輯與靜態核對，未執行本機測試、型別檢查、建置或封裝，未暫存、提交、推送、發布或部署。

## v1.0.11 新增功能（歷史準備紀錄）

- 任務中心與持久化交付進度／重試，購買草稿、到貨訂閱及 7／30 天自動續費預估。
- 節點維護計畫與受限 IPv4 NAT／共享 OVN 冷搬遷，托管提款付款狀態、參考號／憑證及失敗退款流程。
- Agent 背景採集、歷史補送與持久化升級健康確認，宿主 RFW／ZFS 唯讀狀態及獨立管理工具。
- Compose doctor、遷移規劃、更新 preflight 與備份清單；沿用完整 30 件發行資產契約。

本版需交付 `20261110000000_add_delivery_maintenance_stock_payments` migration，升級前備份資料庫與原密鑰，不提供資料庫自動回滾。本次版本同步僅靜態核對，未執行測試、建置、提交或部署；完整發行稿位於 `docs-site/release-notes/v1.0.11.md`。

## 版本号规则 / Versioning Rule

- 唯一版本來源為統一倉庫根 `VERSION`，格式為 canonical `vMAJOR.MINOR.PATCH[-prerelease][+build]`，依根 `RELEASE.md` 契約維護。
- Patch 不限個位數；本輪由來源版本 `v1.0.17` 遞增為 `v1.0.18`，不據此推定前版已發布。
- 核心數字與純數字預發行識別碼不得有前導零；版本檔不得有 BOM、空白或額外行，僅允許可選的一個 LF／CRLF 結尾。
- 歷史 tag、交接與發行說明保留原樣，第三方相依及實際 ZFS 模組版本不跟隨產品升版。

## OTA 发布频率 / OTA Release Frequency

- 不要每修一个小点就发 OTA / Do not publish an OTA for every tiny change.
- 一个功能、一个完整 bugfix、或一组相关修复完成并通过验收后，再发布一个 OTA / Publish one OTA after a feature, complete bugfix, or coherent fix bundle is implemented and verified.
- 纯交接文档、审计记录、非行为性文档补充通常不发 OTA；但公开文档站仍要保持最新 / Handoff-only, audit-only, and non-behavior documentation changes usually do not need an OTA, but the public docs site should stay current.
- 紧急生产修复可以单独发 OTA，但必须包含明确提交说明、测试证据和版本日志 / Emergency production fixes may ship separately, but must include a clear commit subject, verification evidence, and version log updates.

## 歷史已驗證能力

- GitHub Release artifact。
- OTA manifest。
- SHA256 校验。
- `current` / `releases` 原子切换。
- 回滚到上一版 release。
- 回滚后再更新回最新版。

当前公开仓库的发布证据分为两类：

```text
HANDOFF.md
docs-site/docs/release/version-log.md
```

`HANDOFF.md` 保留歷史操作證據；現行目標以根 `VERSION`／`RELEASE.md` 為準，正式發布狀態以 GitHub Release 為準。系統版本日誌從 Git tag 和 commit 自動生成，不作為目前部署或新功能驗收證據。

## Git 更新日志

文档站构建时会自动运行：

```bash
pnpm docs:changelog
```

该命令读取本仓库 Git tag 和 commit，生成：

```text
docs-site/docs/release/version-log.md
docs-site/docs/en/release/version-log.md
```

适合公开展示的发布说明建议继续使用清晰的 commit message 或 GitHub Release 文案。原始 Git log 可以自动收集，但如果提交信息过于工程化，用户看到的更新内容也会偏工程化。
