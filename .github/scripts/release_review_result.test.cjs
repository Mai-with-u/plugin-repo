const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { validateReleaseReview, passedReleases, renderReleaseReview } = require('./release_review_result.cjs');
const { applyReleaseReview } = require('./apply_release_review.cjs');

const plugin = { id: 'example.demo', repositoryUrl: 'https://github.com/example/demo' };
const first = { version: '1.0.0', tag: 'v1.0.0', commit: 'a'.repeat(40) };
const second = { version: '2.0.0', tag: 'v2.0.0', commit: 'b'.repeat(40) };
const targets = { ...plugin, releases: [second, first], discarded: [], base_commit: null };
const issue = { user: { login: 'mai[bot]' }, state: 'open', labels: [{ name: 'plugin-release' }],
  body: `<!-- plugin-release: ${JSON.stringify(targets)} -->` };
function review() {
  return { schema_version: 1, plugin_id: plugin.id, repository_url: plugin.repositoryUrl,
    releases: targets.releases.map(item => ({ ...item, reviewed: true, decision: 'pass', summary: '已检查源码与变更，未发现风险。', risks: [] })) };
}

test('每个版本必须有精确身份、完整且唯一的结构化结论', () => {
  assert.equal(validateReleaseReview(review(), targets).releases.length, 2);
  const mutations = [
    result => { result.schema_version = 2; },
    result => { result.plugin_id = 'other.demo'; },
    result => { result.repository_url = 'https://github.com/other/demo'; },
    result => { result.releases.pop(); },
    result => { result.releases[0] = result.releases[1]; },
    result => { result.releases[0].commit = 'c'.repeat(40); },
    result => { result.releases[0].tag = 'different'; },
    result => { result.releases[0].decision = 'approved'; },
    result => { result.releases[0].reviewed = 'true'; },
    result => { result.releases[0].risks = 'none'; },
    result => { result.releases[0].summary = ''; },
  ];
  for (const mutate of mutations) {
    const result = review();
    mutate(result);
    assert.throws(() => validateReleaseReview(result, targets));
  }
});

test('只有明确通过、源码已检查且风险为空的版本进入自动批准', () => {
  for (const change of [{ decision: 'manual_review' }, { reviewed: false }, { risks: ['存在风险待确认'] }]) {
    const result = review();
    Object.assign(result.releases[0], change);
    validateReleaseReview(result, targets);
    assert.deepEqual(passedReleases(result), [first]);
    assert.match(renderReleaseReview(result), /2\.0\.0：需人工处理/);
  }
});

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automatic-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'plugins.json'), JSON.stringify([plugin]));
  fs.writeFileSync(path.join(root, 'plugin_versions.json'), JSON.stringify({ schema_version: 1, plugins: [] }));
  return root;
}

function request(url) {
  if (url.includes('/releases?')) return Promise.resolve(targets.releases.map(item => ({ tag_name: item.tag, draft: false })));
  const release = targets.releases.find(item => url.endsWith(item.tag) || url.endsWith(item.commit));
  assert.ok(release);
  if (url.includes('/git/ref/')) return Promise.resolve({ object: { type: 'commit', sha: release.commit } });
  const manifest = { manifest_version: 2, id: plugin.id, version: release.version, name: 'demo', description: 'demo', license: 'MIT',
    author: { name: 'example' }, urls: { repository: plugin.repositoryUrl }, capabilities: [], i18n: { default_locale: 'zh-CN' },
    host_application: { min_version: '1.0.0' }, sdk: { min_version: '2.0.0' } };
  return Promise.resolve({ type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(manifest)).toString('base64') });
}

test('混合批次只自动收录安全版本，有风险版本交给人工；全部安全可完成批次', async t => {
  const root = workspace(t);
  const result = review();
  result.releases[0].decision = 'manual_review';
  result.releases[0].risks = ['用户输入拼接到 shell 命令'];
  const outcome = await applyReleaseReview({ root, issue, result, targets, request, botLogin: 'mai[bot]' });
  assert.deepEqual(outcome, { passed: [first], manual: ['2.0.0'] });
  const file = path.join(root, 'plugin_versions.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).plugins[0].versions.map(item => item.version), ['1.0.0']);
  const complete = await applyReleaseReview({ root, issue, result: review(), targets, request, botLogin: 'mai[bot]' });
  assert.deepEqual(complete.manual, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).plugins[0].versions.map(item => item.version), ['2.0.0', '1.0.0']);
});

test('全部不确定时不触碰版本索引，不调用 Release 接口', async t => {
  const root = workspace(t);
  const file = path.join(root, 'plugin_versions.json');
  const before = fs.readFileSync(file, 'utf8');
  const result = review();
  result.releases.forEach(item => { item.reviewed = false; });
  const outcome = await applyReleaseReview({ root, issue, result, targets, request: async () => assert.fail('不应请求'), botLogin: 'mai[bot]' });
  assert.deepEqual(outcome.passed, []);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('审核对象修改、已拒绝或已关闭的批次不会自动放行', async t => {
  const root = workspace(t);
  const changed = { ...targets, releases: [{ ...second, commit: 'c'.repeat(40) }, first] };
  for (const current of [
    { ...issue, body: `<!-- plugin-release: ${JSON.stringify(changed)} -->` },
    { ...issue, state: 'closed' },
    { ...issue, labels: [...issue.labels, { name: 'rejected' }] },
    { ...issue, user: { login: 'attacker' } },
  ]) {
    await assert.rejects(applyReleaseReview({ root, issue: current, result: review(), targets, request, botLogin: 'mai[bot]' }));
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'plugin_versions.json'))).plugins, []);
});

test('自动批准时 Tag 移动不会写入索引', async t => {
  const root = workspace(t);
  const file = path.join(root, 'plugin_versions.json');
  const before = fs.readFileSync(file, 'utf8');
  await assert.rejects(applyReleaseReview({ root, issue, result: review(), targets, botLogin: 'mai[bot]',
    request: async url => url.includes('/git/ref/') && url.endsWith(first.tag)
      ? { object: { type: 'commit', sha: second.commit } } : request(url) }));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
