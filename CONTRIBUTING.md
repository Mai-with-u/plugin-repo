# 如何向麦麦（MaiBot）插件中心贡献插件

感谢您为麦麦分享插件！本指南介绍提交流程和 `_manifest.json` v2 要求。

## 准备工作：插件仓库规范

### 必需文件

| 文件 | 要求 |
|------|------|
| `_manifest.json` | 位于插件仓库根目录，使用 manifest v2 结构 |
| `plugin.py` | 插件入口文件 |
| `LICENSE` | 许可证类型应与 `_manifest.json` 中的 `license` 字段一致 |
| `README.md` | 建议包含功能介绍、安装方式、配置说明和使用示例 |

### 发布要求

提交新增或修改请求前，请先发布至少一个 GitHub Release。支持预发布版本，使用 GitHub 自动生成的源码包即可；草稿和仅创建 Tag 不满足发布要求。移除请求不受此限制。

### `_manifest.json` v2 规范

`_manifest.json` 示例：

```json
{
  "manifest_version": 2,
  "id": "github.username.my-plugin",
  "version": "1.0.0",
  "name": "示例插件",
  "description": "这是一个示例插件",
  "author": {
    "name": "作者名",
    "url": "https://github.com/username"
  },
  "license": "MIT",
  "urls": {
    "repository": "https://github.com/username/my-plugin",
    "homepage": "https://github.com/username/my-plugin",
    "documentation": "https://github.com/username/my-plugin/blob/main/README.md",
    "issues": "https://github.com/username/my-plugin/issues"
  },
  "host_application": {
    "min_version": "1.0.0",
    "max_version": "1.99.99"
  },
  "sdk": {
    "min_version": "2.0.0",
    "max_version": "2.99.99"
  },
  "dependencies": [],
  "capabilities": [],
  "i18n": {
    "default_locale": "zh-CN",
    "supported_locales": ["zh-CN"]
  }
}
```

**必需字段**：`manifest_version`, `id`, `version`, `name`, `description`, `author`, `license`, `urls`, `host_application`, `sdk`, `capabilities`, `i18n`

> [!IMPORTANT]
> - `manifest_version` 必须为 `2`。
> - `id` 应使用稳定、唯一的插件 ID，例如 `github.username.my-plugin`，不要使用空格或路径字符。
> - `version`、`host_application.min_version`、`host_application.max_version`、`sdk.min_version`、`sdk.max_version` 都应使用三段式版本号，例如 `1.0.0`。
> - `author` 包含 `name` 和 `url`。
> - `urls.repository` 必须是公开 GitHub 仓库的 HTTPS 地址。
> - `capabilities` 只声明插件实际需要的能力；没有额外能力时填写空数组。

> [!NOTE]
> `_manifest.json` 中的 `categories`、`keywords`、`repository_url`、`homepage_url` 等未定义字段可能导致 Host 校验失败。

详细文档：[_manifest.json 字段说明](https://docs.mai-mai.org/develop/plugin-dev/manifest)

---

## 发布多个插件版本

插件首次提交前必须发布至少一个 GitHub Release，登记后也应使用 Release 发布新版本：

1. 在目标提交的 `_manifest.json` 中设置三段式 `version`，如 `2.3.0`，准确声明该版本的 `host_application` 和 `sdk` 范围。
2. 保持插件 `id` 不变；历史版本需要修复时，可从维护分支发布新的版本号。
3. 提交代码，创建 `v2.3.0` 或 `2.3.0` Tag，再发布对应 GitHub Release。版本号必须与该提交的 manifest 完全一致。
4. 等待每日同步和版本审核。无风险版本自动收录，有风险或结论不确定的版本交给维护者；授信仓库的合规版本直接收录。

同一版本首次收录后，其 Tag 和 commit 必须保持不变。修复代码时，请发布新的版本号。删除已收录的 Release 会将该版本标记为撤回，并保留历史记录。

历史已登记且没有可识别 Release 的插件继续使用分支安装；新增和修改请求必须满足上述 Release 发布要求。如果已有三段式 Release，但它们全部校验失败，不会转回分支安装。

批次规则、授信配置和客户端行为见 [多版本插件索引说明](./VERSIONING.md)。

## 提交方式：Issue 提交

### 步骤

1. **创建 Issue**：点击 [New Issue](../../issues/new/choose)，选择 **"Add Plugin / 添加插件"** 模板。
2. 填写插件 ID 和公开 GitHub 仓库地址。插件 ID 建议与 `_manifest.json` 的 `id` 一致。
3. **等待验证**：CI 会自动读取插件仓库根目录的 `_manifest.json` 并进行校验，结果会评论在 Issue 中。
4. **等待批准**：验证通过后，维护者会审核并使用 `/approve` 或 `/ap` 批准。

### 状态标签说明

| 标签 | 含义 |
|------|------|
| `pending-validation` | 等待自动验证 |
| `plugin-release` | 已登记插件的发布版本审核 |
| `validated` | 验证通过，等待维护者批准 |
| `validation-failed` | 验证失败，请根据提示修复 |
| `needs-manual-review` | 发布版本存在风险或审核依据不足，等待维护者处理 |
| `approved` | 维护者已批准并添加到插件中心 |
| `auto-approved` | 发布版本全部通过 AI 审核并自动收录 |
| `rejected` | 被维护者拒绝 |

### 可用命令

| 命令 | 谁可以使用 | 说明 |
|------|-----------|------|
| `/recheck` | Issue 作者、维护者 | 重新验证，验证通过后触发 AI 审核，适合修改插件后使用 |
| `/mai_review` 或 `/mr` | 仅维护者 | 按 Issue 标签重新进行 AI 审核；发布版本审核自动收录无风险版本 |
| `/approve` 或 `/ap` | 仅维护者 | 批准插件请求，或收录待审核的发布版本 |
| `/reject 原因` | 仅维护者 | 拒绝插件并说明原因 |

请将命令单独发送为一条新评论。验证失败时，您可以按 Issue 提示修复后发送 `/recheck`。

每个 Issue 最多进行 **8 次** AI 审核，已开始但失败的审核也计入次数。同一 Issue 的审核串行执行；达到上限后仍可验证 manifest。

---

## 常见问题

### 验证错误：无法获取 `_manifest.json`

可能原因：

- 文件名错误，必须是 `_manifest.json`。
- 插件仓库不是公开仓库。
- `_manifest.json` 不在 main/master/dev/develop 分支的根目录。

### 仓库 URL 格式要求

请使用 `https://github.com/username/repo-name`，省略 `.git` 后缀。

---
