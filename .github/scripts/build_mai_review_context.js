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
const REVIEW_MARKER = "<!-- codex-mai-review -->";
const REVIEW_COOLDOWN_MINUTES = [10, 30, 120, 360];
const REVIEW_RESET_MILLISECONDS = 24 * 60 * 60 * 1000;

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

function setOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  fs.appendFileSync(outputPath, `${name}=${String(value).replace(/\r?\n/g, " ")}\n`, "utf8");
}

function getReviewedCommit(body) {
  if (!body || !body.includes(REVIEW_MARKER)) {
    return "";
  }
  const metadataMatch = body.match(/<!-- codex-mai-review-commit: ([0-9a-f]{7,40}) -->/i);
  if (metadataMatch) {
    return metadataMatch[1];
  }
  const match = body.match(/已查看当前版本（`([0-9a-f]{7,40})`）/i);
  return match ? match[1] : "";
}

function decideReview(comments, latestCommitSha, forceReview) {
  if (forceReview) {
    return { shouldReview: true, skipReason: "" };
  }

  const reviewComments = comments.filter((comment) => (comment.body || "").includes(REVIEW_MARKER));
  const reviewedSameCommit = reviewComments.some((comment) => {
    const reviewedCommit = getReviewedCommit(comment.body);
    return reviewedCommit && latestCommitSha.startsWith(reviewedCommit);
  });
  if (reviewedSameCommit) {
    return {
      shouldReview: false,
      skipReason: `跳过 AI 审核：提交 ${latestCommitSha.slice(0, 7)} 已审核过。`,
    };
  }

  const now = Date.now();
  const recentReviews = reviewComments
    .map((comment) => Date.parse(comment.created_at || ""))
    .filter((createdAt) => Number.isFinite(createdAt) && now - createdAt < REVIEW_RESET_MILLISECONDS)
    .sort((left, right) => right - left);
  if (recentReviews.length === 0) {
    return { shouldReview: true, skipReason: "" };
  }

  const cooldownIndex = Math.min(recentReviews.length - 1, REVIEW_COOLDOWN_MINUTES.length - 1);
  const cooldownMinutes = REVIEW_COOLDOWN_MINUTES[cooldownIndex];
  const availableAt = recentReviews[0] + cooldownMinutes * 60 * 1000;
  if (now < availableAt) {
    return {
      shouldReview: false,
      skipReason: `跳过 AI 审核：处于 ${cooldownMinutes} 分钟冷却期，${new Date(availableAt).toISOString()} 后可自动复审。`,
    };
  }

  return { shouldReview: true, skipReason: "" };
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
  let repoFiles = [];
  if (pluginRepo) {
    pluginRepoInfo = await gh(`/repos/${pluginRepo}`);
    latestCommit = await gh(`/repos/${pluginRepo}/commits/${pluginRepoInfo.default_branch}`);

    const manifestResult = await fetchManifestAndBranch(repoUrl, pluginRepoInfo.default_branch);
    manifestBranch = manifestResult.branch || pluginRepoInfo.default_branch;
    manifestText = manifestResult.manifestText || "";
    manifestErrors = manifestResult.manifestErrors || [];

    try {
      const tree = await gh(`/repos/${pluginRepo}/git/trees/${pluginRepoInfo.default_branch}?recursive=1`);
      repoFiles = (tree.tree || [])
        .filter((item) => item.type === "blob")
        .map((item) => item.path);
    } catch (error) {
      repoFiles = [`(无法获取仓库树: ${error.message})`];
    }
  }

  const forceReview = process.env.FORCE_REVIEW === "true";
  const reviewDecision = decideReview(comments, latestCommit?.sha || "", forceReview);
  setOutput("should_review", reviewDecision.shouldReview);
  setOutput("skip_reason", reviewDecision.skipReason);
  setOutput("latest_commit", latestCommit?.sha || "");

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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
