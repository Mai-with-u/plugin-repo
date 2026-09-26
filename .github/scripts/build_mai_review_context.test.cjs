const assert = require("node:assert/strict");
const test = require("node:test");

const { resolveRepoUrl } = require("./build_mai_review_context.js");
const [registeredPlugin] = require("../../plugins.json");

test("new plugin reviews use the submitted repository", () => {
  const issue = {
    labels: [{ name: "plugin-submission" }],
    body: "### 仓库地址 / Repository URL\n\nhttps://github.com/example/new-plugin",
  };
  assert.deepEqual(resolveRepoUrl(issue), {
    requestType: "add",
    repoUrl: "https://github.com/example/new-plugin",
  });
});

test("plugin modification with no new URL reviews the registered repository", () => {
  const issue = {
    labels: [{ name: "plugin-modification" }],
    body: `### 当前插件 ID / Current Plugin ID\n\n${registeredPlugin.id}\n\n### 新的仓库地址（可选） / New Repository URL (Optional)\n\n_No response_`,
  };
  assert.deepEqual(resolveRepoUrl(issue), {
    requestType: "modify",
    repoUrl: registeredPlugin.repositoryUrl,
  });
});

test("plugin modification with a new URL reviews the new repository", () => {
  const issue = {
    labels: [{ name: "plugin-modification" }],
    body: `### 当前插件 ID / Current Plugin ID\n\n${registeredPlugin.id}\n\n### 新的仓库地址（可选） / New Repository URL (Optional)\n\nhttps://github.com/example/replacement`,
  };
  assert.deepEqual(resolveRepoUrl(issue), {
    requestType: "modify",
    repoUrl: "https://github.com/example/replacement",
  });
});

test("plugin removal reviews the registered repository", () => {
  const issue = {
    labels: [{ name: "plugin-removal" }],
    body: `### 插件 ID / Plugin ID\n\n${registeredPlugin.id}\n\n### 仓库地址 / Repository URL\n\nhttps://github.com/example/unrelated`,
  };
  assert.deepEqual(resolveRepoUrl(issue), {
    requestType: "remove",
    repoUrl: registeredPlugin.repositoryUrl,
  });
});
