# 系统版本更新日志

<!-- 此文件由 docs-site/scripts/generate-changelog.mjs 自动生成。请不要手动编辑。 -->

该页面从仓库 Git tag 和 commit 自动生成，用于展示系统版本演进。后台 OTA 的“可更新版本”和生产部署仍以 GitHub Release tag 为准。

## 最新发布状态 / Latest Release State

- 最新发布提交 / Latest Release Commit: ``
- 提交日期 / Commit date: -
- 提交说明 / Commit subject: -
- 最新 tag / Latest tag: 暂无 tag / No tag

## 未发布变更 / Unreleased Changes

- 该 tag 与相邻 tag 指向同一提交，未产生额外 Git commit。

## 历史版本 / Historical Versions

- 暂无版本 tag / No version tags yet.
## 生成方式

在仓库根目录执行：

```bash
pnpm docs:build
```

或者只刷新版本日志：

```bash
pnpm docs:changelog
```

如果 CI 或 GitHub Pages 使用浅克隆，可能拿不到完整 tag。需要在构建前拉取 tags，或改用 GitHub Release API 作为数据源。
