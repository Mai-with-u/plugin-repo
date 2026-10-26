# CNB 自动镜像

GitHub Actions 工作流 **Sync CNB Mirrors** 读取本仓库的插件列表，在 CNB 自动创建公开仓库并同步代码。GitHub 继续作为登记、版本审核和发布信息的来源；安装端暂不改动。

## 配置步骤

### 1. 创建 CNB 组织

在 CNB 创建一个专用公开组织或子组织，例如 `maibot-mirrors/plugins`。组织须允许创建公开仓库，操作账号须具备在该组织建仓、管理仓库设置和推送代码的权限。

所有插件仓库和索引仓库均创建在这个组织下，无需手工逐个建仓，也无需为插件作者创建子组织。

请使用专用镜像组织。工作流会关闭目标仓库的自动构建，并强制更新其管理的分支和 Tag；不要把开发仓库放在这些目标路径中。CNB 的组织规则、保护分支和容量限制仍然有效，若限制强制推送或建仓，需先调整镜像组织的相关规则。

### 2. 创建 CNB 个人访问令牌

打开 [CNB 访问令牌](https://cnb.cool/profile/token)，创建专用访问令牌。选择目标组织适用的资源范围，授权以下权限：

| 权限 | 用途 |
| --- | --- |
| `group-resource:rw` | 在组织下自动创建镜像仓库 |
| `repo-basic-info:r` | 检查仓库是否已存在 |
| `repo-manage:rw` | 关闭镜像仓库的自动构建 |
| `repo-code:rw` | 推送分支、Tag、LFS 和同步状态 |

不需要删除仓库、管理组织成员、写 Issue 或发布 Release 的权限。使用个人访问令牌；只读部署令牌不能完成同步。令牌账号本身也必须拥有相应资源权限。

权限依据：[CNB OpenAPI](https://api.cnb.cool/) 的 `CreateRepo`、`GetByID`、`PutPipelineSettings` 接口；Git 凭据用户名为 `cnb`，密码为访问令牌，参见 [访问令牌文档](https://docs.cnb.cool/zh/guide/access-token.html)。

### 3. 配置 GitHub Actions

在 **本 GitHub 仓库 → Settings → Secrets and variables → Actions** 配置：

| 类型 | 名称 | 必填 | 示例 / 默认值 |
| --- | --- | --- | --- |
| Repository secret | `CNB_TOKEN` | 是 | 上一步的 CNB 个人访问令牌 |
| Repository variable | `CNB_GROUP` | 是 | `maibot-mirrors/plugins`，不要包含域名、首尾斜线 |
| Repository variable | `CNB_REGISTRY_REPO` | 否 | 默认 `plugin-repo`，仅仓库名，不含组织路径 |
| Repository variable | `CNB_SYNC_CONCURRENCY` | 否 | 默认 `4`，可设置 `1` 至 `8` |

没有配置 `CNB_GROUP` 时任务跳过，配置后无需修改工作流。无需额外的 GitHub PAT；读取的都是公开源仓库。不要将 CNB 令牌写进文件、变量或仓库 URL。

### 4. 首次运行

把本次改动推送到 GitHub 默认分支 `main`，完成上述配置后，在 **Actions → Sync CNB Mirrors → Run workflow** 手动执行一次。

任务会自动创建索引仓库和插件仓库，先同步插件，再同步同一份源快照的索引。首次运行需要完整下载历史和 LFS，耗时取决于源仓库大小、网络及 CNB 容量。默认最多四个插件并行，每个 Git 命令最多 15 分钟，整个任务最多 350 分钟。任务超时可重跑；已经推送到 CNB 的仓库不会丢失，但下一次任务仍使用临时目录重新拉取源仓库。

## 自动触发

- 北京时间每天 **02:30 和 15:30** 定时同步。
- `main` 上有代码推送时同步，包括插件列表、版本索引、详情、图标、网页及文档更新。
- **Sync Plugin Index**、**Approve or Reject Plugin**、**Mai Review Plugin Release** 工作流成功结束后同步，覆盖 GitHub 自带令牌提交不会触发后续 push 工作流的情况。
- 支持手动运行。所有触发共用一个并发组，避免同时写同一套镜像。GitHub Actions 定时触发可能延迟。

## 镜像内容和地址

假设 `CNB_GROUP=maibot-mirrors/plugins`：

- 索引仓库：`https://cnb.cool/maibot-mirrors/plugins/plugin-repo`。其 `main` 分支同步源仓库的 `main`，包含 `plugins.json`、`plugin_details.json`、`plugin_versions.json`、归档记录、图标等所有跟踪文件；同时同步源仓库的 Tag。
- 插件仓库：名称为 `p-作者--仓库名-源路径哈希`，前面的可读部分规范化并截断，后面保留 12 位 SHA-256 摘要。同一源仓库复用一个镜像，避免不同作者、符号替换和长名称产生冲突。实际地址以状态文件为准。
- 同步状态：索引镜像的 **`cnb-mirror-status` 分支 → `cnb_mirrors.json`**，例如 `https://cnb.cool/maibot-mirrors/plugins/plugin-repo/-/blob/cnb-mirror-status/cnb_mirrors.json`。该分支独立存放生成结果，不写回 GitHub。

状态文件包含插件 ID、GitHub 原地址、CNB 地址、`synced` / `failed`、成功时间、默认分支及其 commit，失败条目包含错误；索引条目包含源快照 commit。只有完成本轮代码及 LFS 推送后才标记成功。这个状态表示镜像传输结果，不代表额外通过了版本审核。任务摘要提供索引和状态文件链接，Actions 附件保留本轮状态文件 14 天。

插件同步全部分支、Tag 和 Git LFS 对象，保持 commit SHA、注解 Tag 和源码内容。镜像分支及 Tag 会跟随源仓库强制更新、删除；不推送 GitHub 内部的 PR 引用。索引只管理 `main` 和 Tag，保留独立的状态分支。

仅同步活动 `plugins.json` 中的插件；历史示例 `MaiM-with-u.example-plugin1` 与现有索引流程一致跳过。归档记录仍随索引同步，但不为归档插件新建镜像。移出列表的镜像保留，不自动删除仓库。

## 故障处理与边界

- 单个插件失败不会阻断其他插件或索引同步；存在失败时 Actions 标红，并发布本轮状态。失败镜像上已有的代码保留，但多次推送之间可能出现部分更新，应以最新同步状态判断是否可用。
- 若令牌、组织或索引仓库的权限检查失败，任务提前结束；尚未生成的状态文件不会替换上一次状态。任务被终止、超时或 CNB 状态推送失败时同样需结合 Actions 日志和 `generated_at` 判断。
- `401/403`：检查令牌有效期、授权项、目标组织资源范围、账号权限及保护分支规则。`404`：检查组织路径，部分权限不足也可能表现为不可见。容量或 LFS 错误需按日志处理，修复后重跑。
- 推送前通过 API 关闭仓库自动事件、定时任务、NPC 和 Fork 自动构建；设置失败则不上传代码。Git 使用裸仓库，不检出或执行插件代码。Git 凭据仅通过进程环境作用于 `https://cnb.cool/`，不写入远端 URL 或日志。
- Git 镜像不复制 GitHub Release 页面、附件、Issue、PR，也不会递归镜像 submodule、外部模型、运行时下载和 Python/npm 依赖。`plugin_versions.json` 中已有的 Release 信息随索引原样保留。
- `repositoryUrl` 和插件 manifest 均保留 GitHub 地址。已有客户端仍访问 GitHub；后续安装端需读取镜像映射并保留 commit 校验和回退逻辑。
- 插件市场前端由独立仓库维护，不在本仓库的镜像范围内；本阶段交付的是 Git 仓库和索引文件镜像。

## 本地验证

无需令牌或网络访问即可预览全部地址映射：

```powershell
$env:CNB_GROUP = 'maibot-mirrors/plugins'
node .github/scripts/sync_cnb_mirrors.cjs --dry-run
node --test .github/scripts/sync_cnb_mirrors.test.cjs
```

正式同步需要 Node.js 22 或更新版本、Git 和 Git LFS，并设置以上环境变量。工作流在 GitHub Ubuntu runner 上运行；本地运行会实际创建或更新 CNB 镜像，请先检查 dry-run 地址。
