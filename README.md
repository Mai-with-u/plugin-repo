# 麦麦 (MaiBot) 插件中心 (MaiBot Plugin Registry)

[![Validate Plugins](https://github.com/Mai-with-u/plugin-repo/actions/workflows/validate-issue.yml/badge.svg)](https://github.com/Mai-with-u/plugin-repo/actions/workflows/validate-issue.yml)
[![插件数量](https://img.shields.io/badge/dynamic/json?color=blue&label=plugins&query=%24.length&url=https%3A%2F%2Fraw.githubusercontent.com%2FMai-with-u%2Fplugin-repo%2Fmain%2Fplugins.json)](https://github.com/Mai-with-u/plugin-repo/blob/main/plugins.json)

欢迎来到 [麦麦 (MaiBot)](https://github.com/Mai-with-u) 社区插件中心！这里收录社区开发者分享的插件。

## 插件归档

[归档插件列表](./archived_plugins.json) 收录默认分支至少 **365 天没有提交**、且使用 **Manifest v1 或 0.1** 的插件。

归档插件退出活动列表和每日同步。归档列表保留登记信息、归档原因、最近提交时间及详情和版本索引快照。

每次 `Sync Plugin Index` 还会检查活动插件的 GitHub 源仓库。仓库元数据首次返回 404/410（或已转私有），并经不带凭据的第二次请求确认 404/410 后，自动从活动登记、详情及版本索引移除，保存到 `archived_plugins.json`；对应图标随索引生成清理。示例占位项不参与检查。超时、限流、权限错误及 5xx 等异常只警告并保留登记，不会因某个分支或 manifest 文件不存在而归档。清理结果会列在 Action 摘要中；此操作不删除 CNB 镜像仓库。

欢迎作者在恢复维护并升级至 Manifest v2 后，按 [贡献指南](./CONTRIBUTING.md) 申请重新收录。

## 🎯 插件展示页面 

您可以在 **[插件展示页面](https://plugins.maibot.chat/)** 搜索插件、按标签筛选并查看详情。

插件市场前端由独立仓库维护和构建，本仓库负责插件登记、索引、图标及审核同步。原 `docs/` 静态前端产物保留在 `backup/plugin-market-frontend` 备份分支。

## ✨ 工作方式

`plugins.json` 登记插件身份及其公开 GitHub 仓库，提交请求由工作流验证。

插件通过 GitHub Release 发布版本。每日同步发现新版后按插件创建审核批次，麦麦逐版本输出结构化结论，无风险版本自动写入 `plugin_versions.json`，有风险或结论不确定的版本交给维护者；授信开发者的授权仓库可直接更新合规发布版。版本索引供新版麦麦选择兼容版本、固定 commit 安装和锁定更新。发布约定及白名单配置见 [多版本支持说明](./VERSIONING.md)。

## CNB 国内镜像

支持自动将活动插件仓库及本仓库的索引、图标同步到 CNB。配置 `CNB_TOKEN` 和 `CNB_GROUP` 后启用，具体权限、运行方式及同步状态见 [CNB 自动镜像配置](./CNB_MIRRORS.md)。安装端接入另行处理。

## 🚀 如何贡献您的插件

欢迎分享您的插件！请通过 Issue 模板提交，仓库根目录需包含 `_manifest.json` v2。要求及流程见 **[贡献指南](./CONTRIBUTING.md)**。

## ⚖️ 许可证

本仓库本身使用 [MIT License](./LICENSE) 进行许可。所收录的插件使用其各自仓库中指定的许可证。
