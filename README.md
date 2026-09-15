# 麦麦 (MaiBot) 插件中心 (MaiBot Plugin Registry)

[![Validate Plugins](https://github.com/Mai-with-u/plugin-repo/actions/workflows/validate-issue.yml/badge.svg)](https://github.com/Mai-with-u/plugin-repo/actions/workflows/validate-issue.yml)
[![插件数量](https://img.shields.io/badge/dynamic/json?color=blue&label=plugins&query=%24.length&url=https%3A%2F%2Fraw.githubusercontent.com%2FMai-with-u%2Fplugin-repo%2Fmain%2Fplugins.json)](https://github.com/Mai-with-u/plugin-repo/blob/main/plugins.json)
[![GitHub Pages](https://img.shields.io/badge/插件展示-GitHub%20Pages-blue?logo=github)](https://mai-with-u.github.io/plugin-repo/)

欢迎来到麦麦（MaiBot）官方社区插件索引仓库！

这里是所有为 [麦麦 (MaiBot)](https://github.com/Mai-with-u) 开发的社区插件的中央列表。我们的目标是建立一个开放、透明、高质量的插件生态系统。

## 🎯 插件展示页面 

您可以通过我们的 **[插件展示页面](https://plugins.maibot.chat/)** 浏览所有可用的插件，该页面提供了：

- 🔍 智能搜索功能
- 🏷️ 标签分类系统
- 📊 插件详细信息
- 🎨 现代化界面设计
- 📱 移动端适配

## ✨ 工作方式

本仓库通过维护一个核心的 `plugins.json` 文件来索引所有社区插件。所有插件本身都以独立的、公开的 GitHub 仓库形式存在。我们通过自动化的工作流来验证每一个提交，确保其符合社区规范。

插件通过 GitHub Release 发布历史版本，插件中心生成 `plugin_versions.json`，供新版麦麦选择兼容版本、固定 commit 安装和锁定更新。发布约定及客户端接入见 [多版本支持说明](./VERSIONING.md)。

## 🚀 如何贡献您的插件

我们非常欢迎您为麦麦（MaiBot）生态贡献插件！当前推荐通过 Issue 模板提交插件，CI 会自动读取插件仓库根目录的 `_manifest.json` v2 并完成校验。

请详细阅读我们的 **[贡献指南 (CONTRIBUTING.md)](./CONTRIBUTING.md)**，其中包含了所有您需要了解的步骤和规范。

## ⚖️ 许可证

本仓库本身使用 [MIT License](./LICENSE) 进行许可。所收录的插件使用其各自仓库中指定的许可证。
