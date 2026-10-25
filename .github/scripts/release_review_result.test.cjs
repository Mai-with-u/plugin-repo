const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { validateReleaseReview, parseReleaseReview, finalizeReleaseReview, passedReleases, renderReleaseReview } = require('./release_review_result.cjs');
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
    assert.match(renderReleaseReview(result, targets), /2\.0\.0：需人工处理/);
  }
});

test('summary 缺失与空内容仍可定位，长说明和风险不再导致校验失败', () => {
  for (const [summary, message] of [[undefined, /summary 必须是字符串/], ['   ', /summary 不能为空/]]) {
    const result = review();
    result.releases[0].summary = summary;
    assert.throws(() => validateReleaseReview(result, targets), message);
  }
  const result = review();
  result.releases[0].summary = '字'.repeat(100000);
  result.releases[0].risks = Array.from({ length: 25 }, () => '风险'.repeat(5000));
  assert.doesNotThrow(() => validateReleaseReview(result, targets));
  assert.ok(renderReleaseReview(result, targets).length < 60000);
  assert.equal(result.releases[0].summary.length, 100000);
});

test('兼容 BOM、代码块、前后说明和字符串外尾逗号，不改写风险文本', () => {
  const json = JSON.stringify(review());
  for (const text of [json, '\uFEFF' + json, '结果如下：\n```json\n' + json + '\n```\n以上是结论。', json.slice(0, -1) + ',}']) {
    assert.deepEqual(parseReleaseReview(text, targets), review());
  }
  const result = review();
  result.releases[0].risks = ['字符串中的 ,} 和 ,] 及 "引号" 必须保留'];
  assert.deepEqual(parseReleaseReview(JSON.stringify(result), targets).releases[0].risks, result.releases[0].risks);
});

test('兼容协议 1 的字符串写法，纯 JSON、说明文字和代码块保持相同审核结论', () => {
  const expected = review();
  expected.releases[0].decision = 'manual_review';
  expected.releases[0].risks = ['config.toml 已入库，需人工确认'];
  for (const schema_version of ['1', '1.0', ' 1.00 ']) {
    const json = JSON.stringify({ ...expected, schema_version });
    for (const text of [json, '核查完毕。\n\n' + json, '```json\n' + json + '\n```']) {
      const parsed = parseReleaseReview(text, targets);
      assert.deepEqual(parsed, expected);
      assert.deepEqual(passedReleases(parsed), [first]);
    }
  }
});

test('协议容错不放行未知协议、多个结论、身份错误或未经检查的版本', () => {
  const valid = JSON.stringify(review());
  for (const schema_version of [undefined, null, true, '01', '1e0', 'v1', '1.1', '2', 2]) {
    const invalid = JSON.stringify({ ...review(), schema_version });
    for (const text of [invalid, '结论：\n' + invalid, valid + '\n' + invalid]) {
      assert.throws(() => parseReleaseReview(text, targets));
    }
  }
  for (const mutate of [
    result => { result.plugin_id = 'other.demo'; },
    result => { result.repository_url = 'https://github.com/other/demo'; },
    result => { result.releases[0].commit = 'c'.repeat(40); },
    result => { result.releases[0].decision = 'approved'; },
  ]) {
    const result = { ...review(), schema_version: '1.0' };
    mutate(result);
    assert.throws(() => parseReleaseReview(JSON.stringify(result), targets));
  }
  const unchecked = { ...review(), schema_version: '1.0' };
  unchecked.releases[0].reviewed = 'true';
  assert.deepEqual(passedReleases(parseReleaseReview(JSON.stringify(unchecked), targets)), [first]);
  assert.throws(() => parseReleaseReview(valid + '\n' + JSON.stringify(unchecked), targets));
});

test('缺失说明、检查状态或风险列表时该版本降为人工处理', () => {
  for (const field of ['summary', 'reviewed', 'risks']) {
    const result = review();
    delete result.releases[0][field];
    const parsed = parseReleaseReview(JSON.stringify(result), targets);
    assert.equal(parsed.releases[0].decision, 'manual_review');
    assert.deepEqual(passedReleases(parsed), [first]);
  }
});

test('截断、多个 JSON、版本缺失及 commit 不匹配不得自动修复放行', () => {
  const json = JSON.stringify(review());
  for (const text of [json.slice(0, -1), json + '\n' + json]) assert.throws(() => parseReleaseReview(text, targets));
  for (const mutate of [result => { result.releases.pop(); }, result => { result.releases[0].commit = 'c'.repeat(40); }]) {
    const result = review();
    mutate(result);
    assert.throws(() => parseReleaseReview(JSON.stringify(result), targets));
  }
});

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automatic-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'plugins.json'), JSON.stringify([plugin]));
  fs.writeFileSync(path.join(root, 'plugin_versions.json'), JSON.stringify({ schema_version: 1, plugins: [] }));
  return root;
}

test('非法 JSON、协议错误、身份错误和多份结论整批转人工，不使用部分通过结果', () => {
  const json = JSON.stringify(review());
  const invalid = review();
  invalid.plugin_id = 'placeholder';
  for (const raw of [json.slice(0, -1), json + json, JSON.stringify(invalid),
    json.replace('已检查源码与变更，未发现风险。', '返回值 {"success","content"}'),
    JSON.stringify({ ...review(), schema_version: 99 })]) {
    const { result, error } = finalizeReleaseReview(raw, targets);
    assert.ok(error);
    assert.deepEqual(passedReleases(result), []);
    assert.deepEqual(result.releases.map(({ version, tag, commit }) => ({ version, tag, commit })), targets.releases);
    assert.ok(result.releases.every(item => !item.reviewed && item.decision === 'manual_review' && item.risks.length));
    assert.match(renderReleaseReview(result, targets), /codex-review-raw.md/);
  }
  assert.deepEqual(finalizeReleaseReview(json, targets), { result: review(), error: null });
});

test('格式错误的审核经自动收录链路处理后保留全部版本给人工，索引不变', async t => {
  const root = workspace(t);
  const file = path.join(root, 'plugin_versions.json');
  const before = fs.readFileSync(file, 'utf8');
  const { result } = finalizeReleaseReview(JSON.stringify(review()).slice(0, -1), targets);
  const outcome = await applyReleaseReview({ root, issue, result, targets,
    request: async () => assert.fail('不能请求收录'), botLogin: 'mai[bot]' });
  assert.deepEqual(outcome, { passed: [], rejected: [], manual: ['2.0.0', '1.0.0'] });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('工作流校验入口保存原始输出并生成可发布的人工处理报告', t => {
  const root = workspace(t);
  const raw = JSON.stringify(review()).slice(0, -1);
  fs.writeFileSync(path.join(root, 'mai-release-targets.json'), JSON.stringify(targets));
  fs.writeFileSync(path.join(root, 'codex-review.md'), raw);
  execFileSync(process.execPath, [path.join(__dirname, 'release_review_result.cjs')], { cwd: root, stdio: 'pipe' });
  assert.equal(fs.readFileSync(path.join(root, 'codex-review-raw.md'), 'utf8'), raw);
  const result = JSON.parse(fs.readFileSync(path.join(root, 'release-review.json'), 'utf8'));
  validateReleaseReview(result, targets);
  assert.deepEqual(passedReleases(result), []);
  assert.match(fs.readFileSync(path.join(root, 'codex-review.md'), 'utf8'), /需人工处理/);
});

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

test('只有旧版本通过时保留最新 Release 给人工处理', async t => {
  const root = workspace(t);
  const result = review();
  result.releases[0].decision = 'manual_review';
  result.releases[0].risks = ['用户输入拼接到 shell 命令'];
  const outcome = await applyReleaseReview({ root, issue, result, targets, request, botLogin: 'mai[bot]' });
  assert.deepEqual(outcome, { passed: [first], rejected: [], manual: ['2.0.0'] });
  const file = path.join(root, 'plugin_versions.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).plugins[0].versions.map(item => item.version), ['1.0.0']);
  assert.equal(fs.existsSync(path.join(root, 'blocked_release_versions.json')), false);
});

test('全部不确定时不触碰版本索引，不调用 Release 接口', async t => {
  const root = workspace(t);
  const file = path.join(root, 'plugin_versions.json');
  const before = fs.readFileSync(file, 'utf8');
  const result = review();
  result.releases.forEach(item => { item.reviewed = false; });
  const outcome = await applyReleaseReview({ root, issue, result, targets, request: async () => assert.fail('不应请求'), botLogin: 'mai[bot]' });
  assert.deepEqual(outcome.passed, []);
  assert.deepEqual(outcome.rejected, []);
  assert.deepEqual(outcome.manual, ['2.0.0', '1.0.0']);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('最新 Release 以批次发布时间顺序为准，不取最大版本号或模型输出首项', async t => {
  for (const latestPasses of [true, false]) {
    const root = workspace(t);
    const batch = { ...targets, releases: [first, second] };
    const currentIssue = { ...issue, body: `<!-- plugin-release: ${JSON.stringify(batch)} -->` };
    const result = review(); // 模型顺序与批次相反。
    const failed = result.releases.find(item => item.version === (latestPasses ? second.version : first.version));
    failed.reviewed = false;
    const outcome = await applyReleaseReview({ root, issue: currentIssue, result, targets: batch, request, botLogin: 'mai[bot]' });
    assert.deepEqual(outcome, latestPasses
      ? { passed: [first], rejected: [second.version], manual: [] }
      : { passed: [second], rejected: [], manual: [first.version] });
  }
});

test('更高版本通过后自动拒绝风险低版本，持久化且重复执行不重复记录', async t => {
  const root = workspace(t);
  const result = review();
  Object.assign(result.releases[1], { decision: 'manual_review', risks: ['命令注入风险'] });
  assert.match(renderReleaseReview(result, targets), /1\.0\.0：未通过，同批次最新 Release 已通过/);
  for (let i = 0; i < 2; i++) {
    const outcome = await applyReleaseReview({ root, issue, result, targets, request, botLogin: 'mai[bot]' });
    assert.deepEqual(outcome, { passed: [second], rejected: ['1.0.0'], manual: [] });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'blocked_release_versions.json'))), [{ ...plugin, version: first.version }]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'plugin_versions.json'))).plugins[0].versions.map(item => item.version), ['2.0.0']);
    assert.deepEqual(require('./release_commands.cjs').pendingReleases(root, targets), []);
  }
});

test('高版本通过时缺少审核依据的低版本也自动拒绝', async t => {
  for (const field of ['summary', 'reviewed', 'risks']) {
    const root = workspace(t);
    const result = review();
    delete result.releases[1][field];
    const outcome = await applyReleaseReview({ root, issue, result: parseReleaseReview(JSON.stringify(result), targets), targets, request, botLogin: 'mai[bot]' });
    assert.deepEqual(outcome, { passed: [second], rejected: ['1.0.0'], manual: [] });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'blocked_release_versions.json'))), [{ ...plugin, version: first.version }]);
  }
});

test('同批次全部直接通过时收录全部版本，不拒绝也不转人工', async t => {
  const root = workspace(t);
  const outcome = await applyReleaseReview({ root, issue, result: review(), targets, request, botLogin: 'mai[bot]' });
  assert.deepEqual(outcome, { passed: [second, first], rejected: [], manual: [] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'plugin_versions.json'))).plugins[0].versions.map(item => item.version), ['2.0.0', '1.0.0']);
});

test('高版本收录失败时不会提前永久拒绝低版本', async t => {
  const root = workspace(t);
  const result = review();
  Object.assign(result.releases[1], { decision: 'manual_review', risks: ['命令注入风险'] });
  await assert.rejects(applyReleaseReview({ root, issue, result, targets, botLogin: 'mai[bot]',
    request: async () => { throw new Error('请求失败'); } }));
  assert.equal(fs.existsSync(path.join(root, 'blocked_release_versions.json')), false);
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
