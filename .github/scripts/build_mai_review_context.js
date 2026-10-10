const fs = require("fs");

const BRANCHES = ["main", "master", "dev", "develop"];
const IMPORTANT_FILES = [
  "_manifest.json",
  "README.md",
  "README_CN.md",
  "README_zh-CN.md",
  "plugin.py",
  "main.py",
  "config.toml",
  "config.py",
  "pyproject.toml",
  "requirements.txt",
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function gh(path, init = {}) {
  const token = requireEnv("GITHUB_TOKEN");
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "mai-review-bot",
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed: ${path} -> HTTP ${response.status}`);
  }

  return response.json();
}

function extractFirst(body, patterns) {
  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }
  return "";
}

function parseRepoUrl(issueBody, requestType) {
  return extractFirst(issueBody, requestType === "modify"
    ? [/### 新的仓库地址(?:（可选）)? \/ New Repository URL(?: \(Optional\))?\s*\n\s*\n(.+)/]
    : [/### 仓库地址 \/ Repository URL\s*\n\s*\n(.+)/]);
}

function resolveRepoUrl(issue) {
  const body = issue.body || "";
  const labels = (issue.labels || []).map((label) => label.name);
  if (labels.includes('plugin-release')) {
    const { parseReleaseIssue } = require('./release_review.cjs');
    const release = parseReleaseIssue(issue);
    const plugins = JSON.parse(fs.readFileSync('plugins.json', 'utf8'));
    const registered = plugins.find(plugin => plugin.id === release.id);
    if (!registered || registered.repositoryUrl.replace(/\/$/, '').replace(/\.git$/, '') !== release.repositoryUrl) {
      throw new Error('发布审核与插件登记信息不一致');
    }
    return { requestType: 'release', repoUrl: release.repositoryUrl,
      releaseCommit: release.releases[0].commit, releaseBatch: release };
  }
  const requestType = labels.includes("plugin-modification")
    ? "modify"
    : labels.includes("plugin-removal")
      ? "remove"
      : "add";

  if (requestType === "add") {
    return { requestType, repoUrl: parseRepoUrl(body, requestType) };
  }

  const currentPluginId = extractFirst(body, requestType === "modify"
    ? [/### 当前插件 ID \/ Current Plugin ID\s*\n\s*\n(.+)/]
    : [/### 插件 ID \/ Plugin ID\s*\n\s*\n(.+)/]);
  const plugins = JSON.parse(fs.readFileSync("plugins.json", "utf8"));
  const registeredRepoUrl = plugins.find((plugin) => plugin.id === currentPluginId)?.repositoryUrl || "";
  const submittedRepoUrl = requestType === "modify" ? parseRepoUrl(body, requestType) : "";
  return {
    requestType,
    repoUrl: toRepoSlug(submittedRepoUrl) ? submittedRepoUrl : registeredRepoUrl,
  };
}

function toRepoSlug(repoUrl) {
  const match = repoUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/\s]+?)(?:\.git|\/)?$/);
  return match ? match[1] : "";
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "mai-review-bot",
    },
  });
  if (!response.ok) {
    throw new Error(`Fetch failed: ${url} -> HTTP ${response.status}`);
  }
  return response.text();
}

async function fetchManifestAndBranch(repoUrl, branchHint) {
  const errors = [];
  const rawBase = repoUrl.replace("github.com", "raw.githubusercontent.com");
  const candidates = [branchHint, ...BRANCHES].filter(Boolean);

  for (const branch of [...new Set(candidates)]) {
    const url = `${rawBase}/refs/heads/${branch}/_manifest.json`;
    try {
      const text = await fetchText(url);
      return {
        branch,
        manifestText: text,
      };
    } catch (error) {
      errors.push(`- ${branch}: ${error.message}`);
    }
  }

  return {
    branch: "",
    manifestText: "",
    manifestErrors: errors,
  };
}

function sliceText(text, maxLength = 4000) {
  if (!text) {
    return "";
  }
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}\n...<truncated>`;
}

function setOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  fs.appendFileSync(outputPath, `${name}=${String(value).replace(/\r?\n/g, " ")}\n`, "utf8");
}

async function main() {
  const repository = requireEnv("REPOSITORY");
  const issueNumber = requireEnv("ISSUE_NUMBER");

  const issue = await gh(`/repos/${repository}/issues/${issueNumber}`);
  const comments = await gh(`/repos/${repository}/issues/${issueNumber}/comments?per_page=100`);
  const timeline = await gh(`/repos/${repository}/issues/${issueNumber}/timeline?per_page=100`, {
    headers: {
      Accept: "application/vnd.github+json, application/vnd.github.mockingbird-preview+json",
    },
  });

  const { requestType, repoUrl, releaseCommit, releaseBatch } = resolveRepoUrl(issue);
  const pluginRepo = toRepoSlug(repoUrl);

  const maintainerComments = comments.filter((comment) => comment.author_association === "MEMBER");

  let pluginRepoInfo = null;
  let latestCommit = null;
  let manifestBranch = "";
  let manifestText = "";
  let manifestErrors = [];
  let repoFiles = [];
  if (pluginRepo) {
    try {
      pluginRepoInfo = await gh(`/repos/${pluginRepo}`);
      if (releaseCommit) {
        manifestBranch = releaseCommit;
        const file = await gh(`/repos/${pluginRepo}/contents/_manifest.json?ref=${releaseCommit}`);
        if (file.type !== 'file' || file.encoding !== 'base64') throw new Error('发布 manifest 无效');
        manifestText = Buffer.from(file.content, 'base64').toString('utf8');
      } else {
        const manifestResult = await fetchManifestAndBranch(repoUrl, pluginRepoInfo.default_branch);
        manifestBranch = manifestResult.branch || pluginRepoInfo.default_branch;
        manifestText = manifestResult.manifestText || "";
        manifestErrors = manifestResult.manifestErrors || [];
      }
      latestCommit = await gh(`/repos/${pluginRepo}/commits/${encodeURIComponent(manifestBranch)}`);

      try {
        const tree = await gh(`/repos/${pluginRepo}/git/trees/${encodeURIComponent(manifestBranch)}?recursive=1`);
        repoFiles = (tree.tree || [])
          .filter((item) => item.type === "blob")
          .map((item) => item.path);
      } catch (error) {
        repoFiles = [`(无法获取仓库树: ${error.message})`];
      }
    } catch (error) {
      if (requestType !== "remove") {
        throw error;
      }
      manifestErrors.push(`- 原插件仓库不可访问: ${error.message}`);
    }
  }

  setOutput("plugin_repo", latestCommit?.sha ? pluginRepo : "");
  setOutput("latest_commit", latestCommit?.sha || "");
  setOutput('release_batch', Boolean(releaseBatch));
  if (releaseBatch) fs.writeFileSync('mai-release-targets.json', JSON.stringify(releaseBatch));

  const lines = [
    "# 当前 issue 审核上下文",
    "",
    "## Issue 基本信息",
    `- Issue: #${issue.number} ${issue.title}`,
    `- 作者: @${issue.user.login}`,
    `- 状态: ${issue.state}`,
    `- 更新时间: ${issue.updated_at}`,
    `- 标签: ${(issue.labels || []).map((label) => label.name).join(", ")}`,
    `- 插件仓库: ${repoUrl || "(未解析到仓库地址)"}`,
    "",
    "## Issue 正文",
    issue.body || "(空)",
    "",
    "## 历史评论摘要",
    `- 评论总数: ${comments.length}`,
    `- 维护者评论数: ${maintainerComments.length}`,
    "",
    ...comments.slice(-12).flatMap((comment) => [
      `### @${comment.user.login} | ${comment.created_at} | ${comment.author_association}`,
      comment.body || "(空)",
      "",
    ]),
    "## 时间线事件摘要",
    ...timeline
      .filter((event) => ["labeled", "unlabeled", "closed", "reopened"].includes(event.event))
      .slice(-20)
      .map((event) => {
        const label = event.label?.name ? ` ${event.label.name}` : "";
        return `- ${event.created_at} | ${event.actor?.login || "unknown"} | ${event.event}${label}`;
      }),
    "",
    "## 插件仓库信息",
    `- 仓库 slug: ${pluginRepo || "(未解析)"}`,
    `- 仓库地址: ${repoUrl || "(未解析)"}`,
    `- 默认分支: ${pluginRepoInfo?.default_branch || "(未知)"}`,
    `- 最近推送: ${pluginRepoInfo?.pushed_at || "(未知)"}`,
    `- 最新提交: ${latestCommit?.sha || "(未知)"}`,
    `- 最新提交时间: ${latestCommit?.commit?.committer?.date || "(未知)"}`,
    `- 最新提交标题: ${latestCommit?.commit?.message || "(未知)"}`,
    "",
    "## Manifest",
    `- 读取分支: ${manifestBranch || "(失败)"}`,
    manifestText ? sliceText(manifestText, 6000) : "(未获取到 manifest)",
    "",
  ];

  if (manifestErrors.length > 0) {
    lines.push("## Manifest 获取错误", ...manifestErrors, "");
  }

  if (releaseBatch) {
    lines.push('## 发布批次审核',
      `- 已收录基线 commit：${releaseBatch.base_commit || '(无，首个版本需完整审核)'}`,
      '- 以下每个版本都须检查其完整代码及变更，不能只检查最新版本。',
      ...releaseBatch.releases.map(item =>
        `- ${item.version} / ${item.commit}：源码 plugin-release-under-review/${item.version}/；变更 plugin-release-diffs/${item.version}.patch`), '');
  }

  lines.push(
    "## 建议优先检查的文件",
    ...IMPORTANT_FILES.map((file) => `- ${file}`),
    "",
    "## 仓库文件清单摘要",
    ...(repoFiles.length > 0 ? repoFiles.slice(0, 200).map((path) => `- ${path}`) : ["(未获取到文件清单)"]),
    ""
  );

  fs.writeFileSync("mai-review-input.md", lines.join("\n"), "utf8");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { resolveRepoUrl };
