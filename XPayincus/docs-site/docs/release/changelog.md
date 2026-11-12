# 发布说明

发布文档分为两类：

- 本页：人工维护的发布策略、OTA 能力和生产验证说明。
- [系统版本更新日志](/release/version-log)：从 Git tag 和 commit 自动生成的版本记录。

統一發行以根 `VERSION` 與根 `RELEASE.md` 為準。v1.0.11 已正式發布，本輪來源目標為 **v1.0.12（尚未發布）**；歷史 OTA proof 不代表本版驗收結果。

## v1.0.12 新增功能

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
- Patch 不限個位數；本輪由已正式發布的 `v1.0.11` 遞增為 `v1.0.12`。
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
