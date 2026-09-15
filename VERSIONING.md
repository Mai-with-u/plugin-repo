# 插件多版本支持

## 文件职责

- `plugins.json`：人工维护的插件身份和仓库登记信息，继续沿用原有 Issue 审核流程。
- `plugin_details.json`：分支当前 manifest 和展示资源，保持旧客户端的数据协议。
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

`ignored_tags` 记录不符合版本规范的 Tag；`rejected_releases` 记录各版本的格式校验失败原因；`sync_error` 表示整个插件的同步故障。错误不会被当作空版本列表处理。

## 同步与故障处理

同步脚本只读取 GitHub API，不检出或执行第三方插件代码。Release 列表按分页完整读取，manifest 通过解析后的 commit 获取。已收录版本复用原始 manifest 快照并重新检查 Tag 指向。

每个插件独立处理，同步失败保留上次索引并写入 `sync_error`；其他插件继续同步。工作流会发布成功结果和明确错误，并保持失败状态，方便维护者修复后重跑。撤回标记只在成功获取完整 Release 列表后计算。

本地验证：

```powershell
node --test .github/scripts/sync_plugin_versions.test.cjs
```

配置 `GITHUB_TOKEN` 后同步：

```powershell
node .github/scripts/sync_plugin_versions.cjs
```

只重试上次失败或有被拒版本的插件：

```powershell
node .github/scripts/sync_plugin_versions.cjs --retry-errors
```

## 麦麦客户端行为

后端 `GET /api/webui/plugins/releases` 读取索引，调用与插件运行时相同的 manifest、Host、SDK 校验逻辑，为每个版本返回 `compatible`、`reasons`，并给出 `recommended_version`。沿用现有 Host 补丁兼容规则，Python 包及插件依赖在实际安装前验证。

推荐版本为兼容、未撤回、非预发布版本中版本号最高的一项。排序比较数字版本号，不使用发布时间或字符串排序。没有候选时返回明确的不可安装状态。

安装和更新请求增加 `version`、`pinned`：

```json
{
  "plugin_id": "example.demo",
  "repository_url": "https://github.com/example/demo",
  "version": "1.2.3",
  "pinned": true
}
```

`version: "latest"` 选择最新兼容稳定版本；明确版本号允许手动选择历史版或兼容预发布。发布安装的仓库和 commit 由后端索引决定，请求中的仓库地址不覆盖索引。省略 `version` 保留原有分支安装接口，但已通过 Release 安装的插件不能再使用分支拉取更新。

发布安装会在临时目录下载指定 Tag，核对 HEAD 与索引 commit 完全一致，并验证完整 manifest、入口文件、运行环境和插件依赖。随后停止已加载插件，保留配置及数据、备份原目录并替换代码，再恢复之前加载的插件。替换目录失败会恢复原目录；恢复运行失败会明确报告错误，不宣称运行成功。

安装记录保存在插件目录的 `.maibot-release.json`，包含实际版本、commit、仓库与锁定状态。自动更新不会覆盖锁定版本，也不会降级或重装相同版本。手动选择版本时可同时改变安装后的锁定状态。

## 数据与更新边界

- 插件 SDK 的持久数据位于主程序 `data/plugins`，代码替换不会迁移该目录。
- 插件目录中的 `config.toml`、`config_back`、`data` 会保留；Git 插件同时保留未跟踪及被忽略的文件，跳过虚拟环境和运行缓存。
- 非 Git 插件的其他未知文件保留在完整备份目录中，不混入新版本代码。
- 本地已跟踪代码存在修改，或新代码与用户数据路径冲突时，更新会报错。
- 插件目录中的符号链接、目录联接会阻止版本替换。
- 旧目录保存在插件根目录下的 `.update_backups`；降级只切换代码，不自动撤销数据迁移。作者需自行保证数据格式兼容。

## 上线顺序

1. 先发布插件中心的脚本、工作流和版本索引，运行同步并检查错误项。
2. 确认插件中心 `main` 分支可读取 `plugin_versions.json`。
3. 再发布麦麦后端和配套 WebUI。

新 WebUI 依赖后端发布版本接口和远端版本索引；索引不可访问时会明确报错。旧 WebUI 继续读取原来的 `plugin_details.json`，升级后才能使用版本选择。
