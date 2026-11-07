# XPayincus 文件站

本目錄是統一倉庫內獨立的 VitePress 雙語文件 package，不納入面板 pnpm workspace。中文預設路徑為 `/`，英文為 `/en/`。產品版本以根 `../../VERSION` 為準。

## 本地操作

從統一倉庫根目錄執行：

```bash
cd XPayincus
pnpm docs:install
pnpm docs:dev
```

或從 `XPayincus/docs-site/` 執行：

```bash
pnpm install --ignore-workspace
pnpm dev
pnpm build
```

從 `XPayincus/` 可使用 `pnpm docs:build`。建置前會依 Git tags 與 commits 產生 `docs/release/version-log.md`、`docs/en/release/version-log.md`，輸出為 `docs/.vitepress/dist`。這些是操作參考，本次未執行安裝、生成或建置。

## 部署與歷史紀錄

`XPayincus/.github/workflows/docs-pages.yml` 是保留的子目錄 workflow；GitHub Actions 入口在統一倉庫根 `.github/workflows`，目前不能據此前者宣稱文件站會自動部署。若要發布 Pages，需另外配置根 workflow、Pages 來源及 DNS，並取得發布授權。

`docs/public/CNAME` 記錄目標網域 `xpayincus.com`，不代表該網域或線上站點已在本次驗證。歷史 release notes、版本日誌、交接與稽核文件保留原始證據，不作為目前統一版本已建置或上線的證明。

目前架構、Compose 僅面板、CLI 備份與統一發行方式見 [根 README](../../README.md)、[發行說明](../../RELEASE.md) 及 [Compose 說明](../deploy/compose/README.md)。
