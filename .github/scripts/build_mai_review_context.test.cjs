const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveRepoUrl, main } = require("./build_mai_review_context.js");
const [registeredPlugin] = require("../../plugins.json");

test('发布审核固定到 Issue 的 commit，并验证登记仓库', () => {
  const release = { id: registeredPlugin.id, repositoryUrl: registeredPlugin.repositoryUrl,
    version: '1.0.0', tag: 'v1.0.0', commit: 'a'.repeat(40) };
  const issue = { labels: [{ name: 'plugin-release' }], body: `<!-- plugin-release: ${JSON.stringify(release)} -->` };
  assert.deepEqual(resolveRepoUrl(issue), { requestType: 'release', repoUrl: release.repositoryUrl, releaseCommit: release.commit, releaseTarget: { ...release, discarded: [], base_commit: null } });
  release.repositoryUrl = 'https://github.com/other/repo';
  assert.throws(() => resolveRepoUrl({ ...issue, body: `<!-- plugin-release: ${JSON.stringify(release)} -->` }), /不一致/);
});

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

test('首次审核读取 Release 的固定源码而非已前进的分支，并输出可复用快照', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'initial-review-context-'));
  const cwd = process.cwd();
  const names = ['GITHUB_TOKEN', 'REPOSITORY', 'ISSUE_NUMBER', 'GITHUB_OUTPUT'];
  const saved = names.map(name => process.env[name]);
  t.after(() => {
    process.chdir(cwd);
    names.forEach((name, i) => saved[i] === undefined ? delete process.env[name] : process.env[name] = saved[i]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.chdir(root);
  Object.assign(process.env, { GITHUB_TOKEN: 'test', REPOSITORY: 'market/repo', ISSUE_NUMBER: '7', GITHUB_OUTPUT: path.join(root, 'outputs') });
  const sha = 'a'.repeat(40);
  const repoUrl = 'https://github.com/example/demo';
  const manifest = { manifest_version: 2, id: 'example.demo', version: '1.0.0', name: 'demo', description: 'demo',
    author: { name: 'example', url: 'https://github.com/example' }, license: 'MIT', urls: { repository: repoUrl },
    capabilities: [], i18n: { default_locale: 'zh-CN' }, host_application: { min_version: '1.0.0' }, sdk: {} };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    const resource = url.replace('https://api.github.com', '');
    let value;
    if (resource === '/repos/market/repo/issues/7') value = { number: 7, user: { login: 'example' }, labels: [{ name: 'plugin-submission' }],
      body: `### 插件 ID / Plugin ID\n\nexample.demo\n\n### 仓库地址 / Repository URL\n\n${repoUrl}` };
    else if (resource.includes('/comments?') || resource.includes('/timeline?')) value = [];
    else if (resource.includes('/releases?')) value = [{ tag_name: 'v1.0.0', published_at: '2026-10-03', draft: false }];
    else if (resource.includes('/git/ref/')) value = { object: { type: 'commit', sha } };
    else if (resource.includes(`/contents/_manifest.json?ref=${sha}`)) value = { type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(manifest)).toString('base64') };
    else if (resource === '/repos/example/demo') value = { default_branch: 'main' };
    else if (resource === `/repos/example/demo/commits/${sha}`) value = { sha, commit: { committer: {}, message: 'release' } };
    else if (resource === `/repos/example/demo/git/trees/${sha}?recursive=1`) value = { tree: [{ type: 'blob', path: 'plugin.py' }] };
    else assert.fail(`Unexpected branch read: ${resource}`);
    return { ok: true, json: async () => value };
  });
  await main();
  const target = JSON.parse(fs.readFileSync(path.join(root, 'mai-initial-release-target.json')));
  assert.deepEqual(target, { id: manifest.id, repositoryUrl: repoUrl, version: '1.0.0', tag: 'v1.0.0', commit: sha });
  assert.match(fs.readFileSync(path.join(root, 'outputs'), 'utf8'), new RegExp(`latest_commit=${sha}`));
  assert.match(fs.readFileSync(path.join(root, 'mai-review-input.md'), 'utf8'), /首次收录的发布版本/);
  assert.equal(fs.existsSync(path.join(root, 'mai-release-target.json')), false);
  assert.ok(calls.every(url => url.startsWith('https://api.github.com')));
});
