# 麦麦 (MaiBot) 插件中心 (MaiBot Plugin Registry)

[![Validate Plugins](https://github.com/Mai-with-u/plugin-repo/actions/workflows/validate-issue.yml/badge.svg)](https://github.com/Mai-with-u/plugin-repo/actions/workflows/validate-issue.yml)
[![插件数量](https://img.shields.io/badge/dynamic/json?color=blue&label=plugins&query=%24.length&url=https%3A%2F%2Fraw.githubusercontent.com%2FMai-with-u%2Fplugin-repo%2Fmain%2Fplugins.json)](https://github.com/Mai-with-u/plugin-repo/blob/main/plugins.json)
[![GitHub Pages](https://img.shields.io/badge/插件展示-GitHub%20Pages-blue?logo=github)](https://mai-with-u.github.io/plugin-repo/)

欢迎来到 [麦麦 (MaiBot)](https://github.com/Mai-with-u) 社区插件中心！这里收录社区开发者分享的插件。

## 插件归档

[归档插件列表](./archived_plugins.json) 收录默认分支至少 **365 天没有提交**、且使用 **Manifest v1 或 0.1** 的插件。

归档插件退出活动列表和每日同步。归档列表保留登记信息、归档原因、最近提交时间及详情和版本索引快照。

欢迎作者在恢复维护并升级至 Manifest v2 后，按 [贡献指南](./CONTRIBUTING.md) 申请重新收录。

## 🎯 插件展示页面 

您可以在 **[插件展示页面](https://plugins.maibot.chat/)** 搜索插件、按标签筛选并查看详情。

## ✨ 工作方式

`plugins.json` 登记插件身份及其公开 GitHub 仓库，提交请求由工作流验证。

插件通过 GitHub Release 发布版本。每日同步发现新版后按插件创建审核批次，麦麦逐版本输出结构化结论，无风险版本自动写入 `plugin_versions.json`，有风险或结论不确定的版本交给维护者；授信开发者的授权仓库可直接更新合规发布版。版本索引供新版麦麦选择兼容版本、固定 commit 安装和锁定更新。发布约定及白名单配置见 [多版本支持说明](./VERSIONING.md)。

## 🚀 如何贡献您的插件

欢迎分享您的插件！请通过 Issue 模板提交，仓库根目录需包含 `_manifest.json` v2。要求及流程见 **[贡献指南](./CONTRIBUTING.md)**。

## ⚖️ 许可证

本仓库本身使用 [MIT License](./LICENSE) 进行许可。所收录的插件使用其各自仓库中指定的许可证。
