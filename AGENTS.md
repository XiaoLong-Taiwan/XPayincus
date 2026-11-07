# XPayincus 統一倉庫

使用繁體中文溝通。面板相關規範另見 `XPayincus/AGENTS.md`。

- 根 `VERSION` 是整體發行版本，目前為 `v1.0.0`。
- Server 端包含 `XPayincus/client` Dashboard 與 `XPayincus/server` API。
- Agent 端包含 `XPayincus-Agent`、`XPayincus-RFW` 與 `XPayincus-ZFS`。
- Docker Compose 僅用於面板、單一 API 與資料庫；宿主機元件不容器化。
- 後端只能執行單一 Node 程序，不支援多副本。
- 未經要求不 commit、push、建立 tag、發布或改動生產環境。
- 不提交密鑰、資料庫備份、環境設定或執行產物。
- 歷史子目錄 workflow 保留參考；GitHub Actions 入口是根 `.github/workflows`。
