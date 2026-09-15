# 如何向麦麦（MaiBot）插件中心贡献插件

感谢您愿意为麦麦（MaiBot）生态贡献插件。本指南说明当前推荐的插件提交流程，以及插件仓库需要满足的 `_manifest.json` v2 规范。

## 准备工作：插件仓库规范

在提交插件之前，请确保您的插件仓库满足以下要求：

### 必需文件

| 文件 | 要求 |
|------|------|
| `_manifest.json` | 位于插件仓库根目录，使用 manifest v2 结构 |
| `plugin.py` | 插件入口文件 |
| `LICENSE` | 许可证类型应与 `_manifest.json` 中的 `license` 字段一致 |
| `README.md` | 建议包含功能介绍、安装方式、配置说明和使用示例 |

### `_manifest.json` v2 规范

当前新插件应使用 `manifest_version: 2`。下面是一个最小可用示例：

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
> - `author` 必须是包含 `name` 和 `url` 的对象，不能是字符串。
> - `urls.repository` 必须是公开 GitHub 仓库的 HTTPS 地址。
> - `capabilities` 只声明插件实际需要的能力；没有额外能力时填写空数组。

> [!NOTE]
> `categories`、`keywords`、`repository_url`、`homepage_url` 等旧字段属于早期 manifest 或展示侧元数据，不属于当前 Host 严格校验的 manifest v2 字段。新插件不要把这些字段写入 `_manifest.json`，否则可能无法被新版 MaiBot 加载。

详细文档：[_manifest.json 字段说明](https://docs.mai-mai.org/develop/plugin-dev/manifest)

---

## 发布多个插件版本

插件登记后，建议使用 GitHub Release 发布可安装版本：

1. 在目标提交的 `_manifest.json` 中设置三段式 `version`，如 `2.3.0`，准确声明该版本的 `host_application` 和 `sdk` 范围。
2. 保持插件 `id` 不变；历史版本需要修复时，可从维护分支发布新的版本号。
3. 提交代码，创建 `v2.3.0` 或 `2.3.0` Tag，再发布对应 GitHub Release。版本号必须与该提交的 manifest 完全一致。
4. 等待每日同步，或由维护者手动运行 **Sync Plugin Versions** 工作流。

同一版本首次收录后，其 Tag 和 commit 不允许改变。修复代码应发布新的版本号，不要删除并重打同版本 Tag。删除已收录的 Release 会将该版本标记为撤回，历史记录仍然保留。

没有可识别 Release 的插件继续使用分支安装。如果已有三段式 Release，但它们全部校验失败，不会转回分支安装。

完整的数据结构、兼容规则与上线顺序见 [多版本插件索引说明](./VERSIONING.md)。

## 提交方式：Issue 提交

### 步骤

1. **创建 Issue**：点击 [New Issue](../../issues/new/choose)，选择 **"Add Plugin / 添加插件"** 模板。
2. **填写信息**：
   - **插件 ID**：建议与 `_manifest.json` 中的 `id` 保持一致。
   - **仓库地址**：填写完整的公开 GitHub HTTPS URL，例如 `https://github.com/username/my-plugin`。
3. **等待验证**：CI 会自动读取插件仓库根目录的 `_manifest.json` 并进行校验，结果会评论在 Issue 中。
4. **等待批准**：验证通过后，维护者会审核并使用 `/approve` 批准。

### 状态标签说明

| 标签 | 含义 |
|------|------|
| `pending-validation` | 等待自动验证 |
| `validated` | 验证通过，等待维护者批准 |
| `validation-failed` | 验证失败，请根据提示修复 |
| `approved` | 已批准并添加到插件中心 |
| `rejected` | 被维护者拒绝 |

### 可用命令

| 命令 | 谁可以使用 | 说明 |
|------|-----------|------|
| `/recheck` | Issue 作者、维护者 | 重新触发验证，适合修改 manifest 后使用 |
| `/approve` | 仅维护者 | 批准并添加插件 |
| `/reject 原因` | 仅维护者 | 拒绝插件并说明原因 |

### 验证失败怎么办？

1. 根据 Issue 中的错误提示修改插件仓库。
2. 修改完成后，在 Issue 中评论 `/recheck`。
3. CI 会重新验证，结果会再次评论在 Issue 中。

---

## 常见问题

### 验证错误：无法获取 `_manifest.json`

可能原因：

- 文件名错误，必须是 `_manifest.json`。
- 插件仓库不是公开仓库。
- `_manifest.json` 不在 main/master/dev/develop 分支的根目录。

### 验证错误：`author` 字段格式错误

正确格式：

```json
"author": {
  "name": "作者名",
  "url": "https://github.com/username"
}
```

错误格式：

```json
"author": "作者名"
```

### 插件 ID 格式要求

- 推荐：`github.username.my-plugin`
- 可以：`username.my-plugin`
- 不要使用：`My Plugin`
- 不要使用：`../path`

### 仓库 URL 格式要求

- 推荐：`https://github.com/username/repo-name`
- 不要使用：`https://github.com/username/repo-name.git`
- 不要使用：`git@github.com:username/repo-name.git`

---
