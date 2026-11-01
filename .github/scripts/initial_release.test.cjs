const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { selectInitialRelease, initialReleaseMarker, reviewedInitialRelease, recordInitialRelease } = require('./initial_release.cjs');
const { syncPlugin } = require('./sync_plugin_versions.cjs');
const { createReleaseGate } = require('./release_review.cjs');

const plugin = { id: 'example.demo', repositoryUrl: 'https://github.com/example/demo' };
const target = { ...plugin, version: '1.0.0', tag: 'v1.0.0', commit: 'a'.repeat(40) };
const botLogin = 'mai[bot]';
const manifest = {
  manifest_version: 2, id: plugin.id, version: '1.0.0', name: 'demo', description: 'demo',
  author: { name: 'example', url: 'https://github.com/example' }, license: 'MIT',
  urls: { repository: plugin.repositoryUrl }, capabilities: [], i18n: { default_locale: 'zh-CN' },
  host_application: { min_version: '1.0.0' }, sdk: { min_version: '2.0.0' },
};
const releases = [
  { id: 2, tag_name: 'v2.0.0', published_at: '2026-10-02T00:00:00Z', draft: false },
  { id: 1, tag_name: 'v1.0.0', published_at: '2026-10-03T00:00:00Z', draft: false },
];
function client({ list = releases, commit = target.commit, badManifest = false, config = false, annotated = false } = {}) {
  return async url => {
    if (url.includes('/releases?')) return list;
    if (url.includes('/git/ref/')) return { object: { type: annotated ? 'tag' : 'commit', sha: url.endsWith('v1.0.0') ? commit : 'b'.repeat(40) } };
    if (url.includes('/git/tags/')) return { object: { type: 'commit', sha: commit } };
    if (url.includes('/contents/?ref=')) return config ? [{ name: 'config.toml' }] : [];
    if (url.includes('/contents/_manifest.json?ref=')) return { type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify({
      ...manifest, version: badManifest ? '3.0.0' : url.endsWith('b'.repeat(40)) ? '2.0.0' : '1.0.0',
    })).toString('base64') };
    throw new Error(url);
  };
}
function review(extra = {}) {
  return { id: 9, user: { login: botLogin, type: 'Bot' }, body:
    `<!-- codex-mai-review -->\n<!-- codex-mai-review-run: 123:1 -->\n<!-- codex-mai-review-commit: ${target.commit} -->\n${initialReleaseMarker(target)}已检查源码。`, ...extra };
}
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'initial-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'plugins.json'), JSON.stringify([plugin]));
  fs.writeFileSync(path.join(root, 'trusted_developers.json'), '[]');
  fs.writeFileSync(path.join(root, 'plugin_versions.json'), JSON.stringify({ schema_version: 1, plugins: [] }));
  return root;
}

test('首次审核按发布时间固定 Release，支持注解 Tag，排除草稿及非版本 Tag', async () => {
  const list = [...releases, { id: 3, tag_name: 'v3.0.0', draft: true, published_at: '2026-10-04' },
    { id: 4, tag_name: 'latest', draft: false, published_at: '2026-10-05' }];
  assert.deepEqual(await selectInitialRelease({ plugin, request: client({ list, annotated: true }) }), target);
  await assert.rejects(selectInitialRelease({ plugin, request: client({ list: [] }) }), /已发布/);
  await assert.rejects(selectInitialRelease({ plugin, request: client({ badManifest: true }) }), /不一致/);
});

test('首次 Release 分页读取，不把第一页顺序当作发布时间顺序', async () => {
  const request = client();
  const paged = url => url.includes('/releases?')
    ? url.endsWith('page=1') ? Array(100).fill(releases[0]) : [releases[1]] : request(url);
  assert.deepEqual(await selectInitialRelease({ plugin, request: paged }), target);
});

test('只复用最新正式 App 评论的固定头部快照，忽略伪造作者及正文中的引用', () => {
  const read = comments => reviewedInitialRelease({ comments, plugin, botLogin });
  assert.equal(read([review({ user: { login: 'user', type: 'User' } })]), null);
  assert.equal(read([review({ user: { login: 'other[bot]', type: 'Bot' } })]), null);
  assert.equal(read([review({ body: '普通评论\n' + review().body })]), null);
  assert.deepEqual(read([review()]), { ...target, discarded: [], base_commit: null });
  assert.deepEqual(read([review({ body: review().body.replaceAll('\n', '\r\n') })]), { ...target, discarded: [], base_commit: null });
  const legacy = review({ body: review().body.replace(initialReleaseMarker(target), '审核正文\n') });
  assert.equal(read([review(), legacy]), null);
  for (const body of ['<!-- codex-mai-review-start: 124:1 -->', '<!-- codex-mai-review-failed: 124:1 -->']) {
    assert.throws(() => read([review(), review({ body })]), /尚未完成/);
  }
  for (const changed of [{ ...plugin, id: 'other.demo' }, { ...plugin, repositoryUrl: 'https://github.com/other/demo' }]) {
    assert.throws(() => reviewedInitialRelease({ comments: [review()], plugin: changed, botLogin }), /已改变/);
  }
  assert.throws(() => read([review({ body: review().body.replace(`commit: ${target.commit}`, `commit: ${'c'.repeat(40)}`) })]), /commit 不一致/);
});

test('首次批准只收录审核快照，后续同步不会为同版本开单，新版仍进入审核', async t => {
  const root = workspace(t);
  await recordInitialRelease({ root, plugin, target, request: client() });
  const previous = JSON.parse(fs.readFileSync(path.join(root, 'plugin_versions.json'))).plugins[0];
  assert.deepEqual(previous.versions.map(item => item.version), ['1.0.0']);
  const posts = [];
  const request = async (url, init) => {
    if (init) { posts.push(JSON.parse(init.body)); return { number: 20, state: 'open', labels: [] }; }
    if (url.includes('/issues?')) return [];
    if (url === '/repos/example/demo') return { owner: { id: 10 }, full_name: 'example/demo' };
    return client()(url);
  };
  const gate = await createReleaseGate({ root, request, repository: 'market/repo', botLogin });
  const synced = await syncPlugin(plugin, previous, request, plugin.id, gate);
  await gate.flush(plugin, previous);
  assert.deepEqual(synced.versions.map(item => item.version), ['1.0.0']);
  assert.equal(posts.length, 2);
  assert.match(posts[0].title, /2\.0\.0/);
  assert.doesNotMatch(posts[0].body, /v1\.0\.0/);
});

test('撤回、Tag 改写、manifest 变动、根目录配置及永久拒绝均不能复用首次审核', async t => {
  const root = workspace(t);
  const file = path.join(root, 'plugin_versions.json');
  const before = fs.readFileSync(file, 'utf8');
  for (const options of [{ list: [] }, { commit: 'c'.repeat(40) }, { badManifest: true }, { config: true }]) {
    await assert.rejects(recordInitialRelease({ root, plugin, target, request: client(options) }), /重新审核/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
  fs.writeFileSync(path.join(root, 'blocked_release_versions.json'), JSON.stringify([{ ...plugin, version: '1.0.0' }]));
  await assert.rejects(recordInitialRelease({ root, plugin, target, request: client() }), /永久拒绝/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('首次批准工作流同时写入登记和版本，推送重放仍使用原快照', async t => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, 'plugins.json'), '[]');
  const source = fs.readFileSync(path.join(__dirname, '../workflows/approve-plugin.yml'), 'utf8').replaceAll('\r\n', '\n');
  const step = source.split('      - name: Parse issue and add plugin\n')[1].split('\n      - name:')[0];
  const script = step.split('          script: |\n')[1].trimEnd().split('\n').map(line => line.slice(12)).join('\n');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const outputs = {};
  const issue = { body: `### 插件 ID / Plugin ID\n\n${plugin.id}\n\n### 仓库地址 / Repository URL\n\n${plugin.repositoryUrl}`,
    labels: [{ name: 'plugin-submission' }] };
  // A later review must not replace the snapshot authorized by this /ap.
  const comments = [review(), review({ id: 11, body: '<!-- codex-mai-review-start: 124:1 -->' })];
  const github = { rest: { issues: { get: async () => ({ data: issue }), listComments() {} } },
    paginate: async () => comments, request: async method => ({ data: await client()(method.slice(4)) }) };
  const context = { repo: { owner: 'market', repo: 'repo' }, issue: { number: 7 },
    payload: { issue, comment: { id: 10 } } };
  const localRequire = name => name === 'fs' ? {
    readFileSync: (file, ...args) => fs.readFileSync(path.resolve(root, file), ...args),
    writeFileSync: (file, ...args) => fs.writeFileSync(path.resolve(root, file), ...args),
  } : require(path.resolve(__dirname, '../..', name));
  const process = { cwd: () => root, env: { MAI_REVIEW_BOT_LOGIN: botLogin } };
  await new AsyncFunction('require', 'github', 'context', 'core', 'process', script)(
    localRequire, github, context, { setFailed: assert.fail, warning: assert.fail, setOutput: (key, value) => { outputs[key] = value; } }, process);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'plugins.json'))), [plugin]);
  assert.equal(outputs.initial_release_version, '1.0.0');
  const approved = fs.readFileSync(path.join(root, 'initial-release-approval.json'), 'utf8');
  assert.equal(JSON.parse(approved).commit, target.commit);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'plugin_versions.json'))).plugins[0].versions[0].commit, target.commit);

  // Simulate git reset to an upstream main with no plugin, then replay the
  // actual heredoc against that state using the same pinned approval file.
  fs.writeFileSync(path.join(root, 'plugins.json'), '[]');
  fs.writeFileSync(path.join(root, 'plugin_versions.json'), JSON.stringify({ schema_version: 1, plugins: [] }));
  process.env = { REQUEST_TYPE: 'add', PLUGIN_ID: plugin.id, REPO_URL: plugin.repositoryUrl };
  // The real client uses fetch; keep all requests local to this test.
  t.mock.method(globalThis, 'fetch', async url => ({ ok: true, json: () => client()(url.replace('https://api.github.com', '')) }));
  const replay = source.split("          node <<'EOL'\n")[1].split('\n          EOL')[0]
    .split('\n').map(line => line.slice(10)).join('\n');
  await new AsyncFunction('require', 'process', `return ${replay}`)(localRequire, process);
  assert.equal(process.exitCode, undefined);
  assert.equal(fs.readFileSync(path.join(root, 'initial-release-approval.json'), 'utf8'), approved);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'plugin_versions.json'))).plugins[0].versions[0].commit, target.commit);
});
