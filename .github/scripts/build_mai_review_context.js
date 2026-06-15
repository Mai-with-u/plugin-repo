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
const CODE_FILE_SUFFIXES = [".py", ".js", ".ts"];
const RISK_PATTERN =
  /\b(eval|exec|subprocess|os\.system|Popen|shell=True|requests\.|httpx\.|aiohttp|urllib|socket|open\(|write_text|write_bytes|unlink\(|remove\(|rmtree|shutil|sqlite|aiosqlite|api\.call|chat\.open_session|get_stream_by_|get_private_streams|get_group_streams|send\.image|send_image)\b/i;

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

function parseRepoUrl(issueBody) {
  return extractFirst(issueBody, [
    /### 仓库地址 \/ Repository URL\s*\n\s*\n(.+)/,
    /### 新的仓库地址(?:（可选）)? \/ New Repository URL(?: \(Optional\))?\s*\n\s*\n(.+)/,
  ]);
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

function buildRawFileUrl(repoUrl, branch, path) {
  const rawBase = repoUrl.replace("github.com", "raw.githubusercontent.com");
  return `${rawBase}/refs/heads/${branch}/${path}`;
}

async function fetchImportantFiles(repoUrl, branch, treeItems) {
  const selectedPaths = new Set();

  for (const file of IMPORTANT_FILES) {
    if (treeItems.some((item) => item.path === file)) {
      selectedPaths.add(file);
    }
  }

  for (const item of treeItems) {
    if (
      CODE_FILE_SUFFIXES.some((suffix) => item.path.endsWith(suffix)) &&
      !item.path.includes("/") &&
      selectedPaths.size < 10
    ) {
      selectedPaths.add(item.path);
    }
  }

  const files = [];
  for (const path of selectedPaths) {
    try {
      const text = await fetchText(buildRawFileUrl(repoUrl, branch, path));
      files.push({ path, content: sliceText(text) });
    } catch (error) {
      files.push({ path, content: `无法获取文件内容：${error.message}` });
    }
  }
  return files;
}

function collectRiskHits(files) {
  const hits = [];
  for (const file of files) {
    const lines = file.content.split("\n");
    lines.forEach((line, index) => {
      if (RISK_PATTERN.test(line)) {
        hits.push(`${file.path}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  return hits.slice(0, 40);
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

  const repoUrl = parseRepoUrl(issue.body || "");
  const pluginRepo = toRepoSlug(repoUrl);

  const maintainerComments = comments.filter((comment) => comment.author_association === "MEMBER");

  let pluginRepoInfo = null;
  let latestCommit = null;
  let manifestBranch = "";
  let manifestText = "";
  let manifestErrors = [];
  let importantFiles = [];
  let riskHits = [];

  if (pluginRepo) {
    pluginRepoInfo = await gh(`/repos/${pluginRepo}`);
    latestCommit = await gh(`/repos/${pluginRepo}/commits/${pluginRepoInfo.default_branch}`);

    const manifestResult = await fetchManifestAndBranch(repoUrl, pluginRepoInfo.default_branch);
    manifestBranch = manifestResult.branch || pluginRepoInfo.default_branch;
    manifestText = manifestResult.manifestText || "";
    manifestErrors = manifestResult.manifestErrors || [];

    try {
      const tree = await gh(`/repos/${pluginRepo}/git/trees/${pluginRepoInfo.default_branch}?recursive=1`);
      importantFiles = await fetchImportantFiles(repoUrl, pluginRepoInfo.default_branch, tree.tree || []);
      riskHits = collectRiskHits(importantFiles);
    } catch (error) {
      importantFiles = [{ path: "(tree)", content: `无法获取仓库树：${error.message}` }];
    }
  }

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

  lines.push(
    "## 风险命中片段",
    ...(riskHits.length > 0 ? riskHits : ["(未命中预设风险关键词)"]),
    "",
    "## 关键文件摘录"
  );

  for (const file of importantFiles) {
    lines.push(`### ${file.path}`, file.content, "");
  }

  fs.writeFileSync("mai-review-input.md", lines.join("\n"), "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
