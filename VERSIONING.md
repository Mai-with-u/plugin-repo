# 插件多版本支持

## 文件职责

- `plugins.json`：人工维护的插件身份和仓库登记信息。
- `plugin_details.json`：分支当前 manifest 和展示资源。
- `plugin_versions.json`：工作流生成的版本历史，根对象包含 `schema_version: 1` 和 `plugins`。

每个版本索引条目包含 `id`（登记 ID）、`manifest_id`（稳定的运行时 ID）、`repositoryUrl`、`mode` 和 `versions`。`mode` 为 `releases` 或 `branch`。登记 ID 与 manifest ID 可以不同，后端支持两者查询；不同插件不能共享同一身份。

每个发布版本保存：

| 字段 | 含义 |
| --- | --- |
| `version` | manifest 的三段式插件版本号 |
| `tag` | 完整 Tag 名，允许 `1.2.3` 或 `v1.2.3` |
| `commit` | 解析 Tag 后的完整 40 位 commit SHA，支持注解 Tag |
| `manifest` | 从该 commit 读取的完整 manifest 快照 |
| `prerelease` | 是否为预发布 |
| `yanked` | 之前已收录但当前被删除或转为草稿的 Release |
| `published_at` | GitHub Release 发布时间 |
| `release_url` | GitHub Release 页面 |
| `release_notes` | GitHub Release 发布说明 |

`ignored_tags` 记录不符合版本规范的 Tag；`rejected_releases` 记录各版本的格式校验失败原因；`sync_error` 表示整个插件的同步故障。

## 同步与故障处理

每日北京时间 03:15 和 18:15，**Sync Plugin Index** 检查已登记插件的 Release。每个插件新发现的合规版本组成一个 `plugin-release` 审核批次，按发布时间取最新的最多 5 个，其余跳过。待审期间的新 Release 另开批次。定时和手动同步均跳过已收录、已有 Issue 或已跳过的版本。

麦麦检查各版本固定 commit 的源码和变更，输出逐版本 JSON 结论。`decision` 为 `pass`、已检查源码且风险列表为空的版本，经 Tag、commit 和 manifest 复核后写入 `plugin_versions.json`。整批通过后标记 `auto-approved` 并关闭 Issue。

有风险或审核依据不足的版本标记 `needs-manual-review`。解析失败、批次被修改或收录失败时保留 Issue，等待维护者处理。维护者可用 `/approve` 或 `/ap` 批准剩余版本，标记为 `approved`；用 `/reject 原因` 拒绝。待审期间，插件中心继续提供已收录版本。

维护者可发送 `/mai_review` 或 `/mr` 重新审核；`plugin-release` 标签选择发布版本审核，其余插件请求进入登记审核。

审核结果会通过独立评论通知开发者，列出成功收录、未通过或收录失败、待确认的版本。个人仓库通知所有者，组织仓库通知 Release 发布者；每个 Issue 最多通知一次。

发布审核通过 JSON Schema 约束输出，格式校验失败时最多重试 3 次。结果解析支持 JSON 代码块、前后说明和尾逗号。审核说明、源码检查状态或风险列表缺失时转人工。输出额度为 64,000 token；过长内容在 Issue 中展示摘要，完整结果保留在审核产物中。

`trusted_developers.json` 配置可直接更新发布版的授信开发者。每项使用 GitHub 仓库所有者的数字 ID 和具体仓库名，例如：

```json
[
  { "owner_id": 123456, "repositories": ["developer/plugin-repository"] }
]
```

名单由维护者管理，按 GitHub API 返回的仓库所有者数字 ID 和具体仓库授权；组织仓库使用组织数字 ID。授信版本须通过格式、插件身份和 Tag/commit 一致性检查。

同步和发布审批使用 `MAI_REVIEW_APP_ID`、`MAI_REVIEW_APP_PRIVATE_KEY`，GitHub App 需要读取插件市场内容及写入 Issue 的权限；麦麦审核需要 `STEP_API_KEY`。

同步脚本通过 GitHub API 获取发布信息和创建审核 Issue，不检出或执行第三方插件代码。Release 列表按分页完整读取，manifest 通过解析后的 commit 获取。已收录版本复用原始 manifest 快照并重新检查 Tag 指向。

每个插件独立处理，同步失败保留上次索引并写入 `sync_error`；其他插件继续同步。异常原因公开在索引中，维护者修复后可重跑。撤回标记只在成功获取完整 Release 列表后计算。

本地验证：

```powershell
node --test .github/scripts/*.test.cjs
```

配置 GitHub App 的 `GITHUB_TOKEN`、市场仓库 `GITHUB_REPOSITORY` 和 App 的机器人登录名 `MAI_REVIEW_BOT_LOGIN`（如 `app-name[bot]`）后同步：

```powershell
node .github/scripts/sync_plugin_versions.cjs
```

只重试上次失败或有被拒版本的插件：

```powershell
node .github/scripts/sync_plugin_versions.cjs --retry-errors
```

## 麦麦客户端行为

后端 `GET /api/webui/plugins/releases` 读取索引，通过运行时的 manifest、Host、SDK 校验，为每个版本返回 `compatible`、`reasons`，并给出 `recommended_version`。Python 包及插件依赖在安装前验证。

推荐版本为兼容、未撤回的稳定版本中版本号最高的一项，按数字版本号排序。没有候选时返回不可安装状态。

安装和更新请求示例：

```json
{
  "plugin_id": "example.demo",
  "repository_url": "https://github.com/example/demo",
  "version": "1.2.3",
  "pinned": true
}
```

`version: "latest"` 选择最新兼容稳定版本；指定版本号可选择历史版或兼容预发布。Release 安装使用索引中的仓库和 commit。省略 `version` 使用分支安装；已通过 Release 安装的插件须通过 Release 更新。

发布安装下载指定 Tag，核对 HEAD 与索引 commit，并验证 manifest、入口文件、运行环境和依赖。随后停止插件，保留配置及数据、备份原目录、替换代码并恢复运行。目录替换失败时恢复原目录；运行恢复失败时报告错误。

安装记录保存在插件目录的 `.maibot-release.json`，包含实际版本、commit、仓库与锁定状态。自动更新不会覆盖锁定版本，也不会降级或重装相同版本。手动选择版本时可同时改变安装后的锁定状态。

## 数据与更新边界

- 插件 SDK 的持久数据位于主程序 `data/plugins`，代码替换不会迁移该目录。
- 插件目录中的 `config.toml`、`config_back`、`data` 会保留；Git 插件同时保留未跟踪及被忽略的文件，跳过虚拟环境和运行缓存。
- 非 Git 插件的其他未知文件保留在完整备份目录中，不混入新版本代码。
- 本地已跟踪代码存在修改，或新代码与用户数据路径冲突时，更新会报错。
- 插件目录中的符号链接、目录联接会阻止版本替换。
- 旧目录保存在插件根目录下的 `.update_backups`；降级只切换代码，不自动撤销数据迁移。作者需自行保证数据格式兼容。

版本选择依赖后端发布版本接口和远端 `plugin_versions.json`；索引不可访问时报告错误。使用 `plugin_details.json` 的客户端通过分支安装插件。
