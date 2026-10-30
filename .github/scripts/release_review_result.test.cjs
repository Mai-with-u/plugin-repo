const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { validateReleaseReview, parseReleaseReview, finalizeReleaseReview, isReleasePassed, renderReleaseReview } = require('./release_review_result.cjs');
const { applyReleaseReview } = require('./apply_release_review.cjs');

const plugin = { id: 'example.demo', repositoryUrl: 'https://github.com/example/demo' };
const first = { version: '1.0.0', tag: 'v1.0.0', commit: 'a'.repeat(40) };
const second = { version: '2.0.0', tag: 'v2.0.0', commit: 'b'.repeat(40) };
const targets = { ...plugin, ...second, discarded: [], base_commit: null };
const issue = { user: { login: 'mai[bot]' }, state: 'open', labels: [{ name: 'plugin-release' }],
  body: `<!-- plugin-release: ${JSON.stringify(targets)} -->` };
function review() {
  return { schema_version: 2, plugin_id: plugin.id, repository_url: plugin.repositoryUrl,
    ...second, reviewed: true, decision: 'pass', summary: '已检查源码与变更，未发现风险。', risks: [] };
}

test('单版本必须有精确身份、完整且唯一的结构化结论', () => {
  assert.equal(validateReleaseReview(review(), targets).version, second.version);
  const mutations = [
    result => { result.schema_version = 1; },
    result => { result.plugin_id = 'other.demo'; },
    result => { result.repository_url = 'https://github.com/other/demo'; },
    result => { delete result.version; },
    result => { result.releases = [result]; },
    result => { result.commit = 'c'.repeat(40); },
    result => { result.tag = 'different'; },
    result => { result.decision = 'approved'; },
    result => { result.reviewed = 'true'; },
    result => { result.risks = 'none'; },
    result => { result.summary = ''; },
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
    Object.assign(result, change);
    validateReleaseReview(result, targets);
    assert.deepEqual(isReleasePassed(result), false);
    assert.match(renderReleaseReview(result, targets), /2\.0\.0：需人工处理/);
  }
});

test('summary 缺失与空内容仍可定位，长说明和风险不再导致校验失败', () => {
  for (const [summary, message] of [[undefined, /summary 必须是字符串/], ['   ', /summary 不能为空/]]) {
    const result = review();
    result.summary = summary;
    assert.throws(() => validateReleaseReview(result, targets), message);
  }
  const result = review();
  result.summary = '字'.repeat(100000);
  result.risks = Array.from({ length: 25 }, () => '风险'.repeat(5000));
  assert.doesNotThrow(() => validateReleaseReview(result, targets));
  assert.ok(renderReleaseReview(result, targets).length < 60000);
  assert.equal(result.summary.length, 100000);
});

test('兼容 BOM、代码块、前后说明和字符串外尾逗号，不改写风险文本', () => {
  const json = JSON.stringify(review());
  for (const text of [json, '\uFEFF' + json, '结果如下：\n```json\n' + json + '\n```\n以上是结论。', json.slice(0, -1) + ',}']) {
    assert.deepEqual(parseReleaseReview(text, targets), review());
  }
  const result = review();
  result.risks = ['字符串中的 ,} 和 ,] 及 "引号" 必须保留'];
  assert.deepEqual(parseReleaseReview(JSON.stringify(result), targets).risks, result.risks);
});

test('兼容协议 2 的字符串写法，纯 JSON、说明文字和代码块保持相同审核结论', () => {
  const expected = review();
  expected.decision = 'manual_review';
  expected.risks = ['config.toml 已入库，需人工确认'];
  for (const schema_version of ['2', '2.0', ' 2.00 ']) {
    const json = JSON.stringify({ ...expected, schema_version });
    for (const text of [json, '核查完毕。\n\n' + json, '```json\n' + json + '\n```']) {
      const parsed = parseReleaseReview(text, targets);
      assert.deepEqual(parsed, expected);
      assert.deepEqual(isReleasePassed(parsed), false);
    }
  }
});

test('协议容错不放行未知协议、多个结论、身份错误或未经检查的版本', () => {
  const valid = JSON.stringify(review());
  for (const schema_version of [undefined, null, true, '01', '1e0', 'v1', '2.1', '1', 1]) {
    const invalid = JSON.stringify({ ...review(), schema_version });
    for (const text of [invalid, '结论：\n' + invalid, valid + '\n' + invalid]) {
      assert.throws(() => parseReleaseReview(text, targets));
    }
  }
  for (const mutate of [
    result => { result.plugin_id = 'other.demo'; },
    result => { result.repository_url = 'https://github.com/other/demo'; },
    result => { result.commit = 'c'.repeat(40); },
    result => { result.decision = 'approved'; },
  ]) {
    const result = { ...review(), schema_version: '2.0' };
    mutate(result);
    assert.throws(() => parseReleaseReview(JSON.stringify(result), targets));
  }
  const unchecked = { ...review(), schema_version: '2.0' };
  unchecked.reviewed = 'true';
  assert.deepEqual(isReleasePassed(parseReleaseReview(JSON.stringify(unchecked), targets)), false);
  assert.throws(() => parseReleaseReview(valid + '\n' + JSON.stringify(unchecked), targets));
});

test('缺失说明、检查状态或风险列表时该版本降为人工处理', () => {
  for (const field of ['summary', 'reviewed', 'risks']) {
    const result = review();
    delete result[field];
    const parsed = parseReleaseReview(JSON.stringify(result), targets);
    assert.equal(parsed.decision, 'manual_review');
    assert.deepEqual(isReleasePassed(parsed), false);
  }
});

test('截断、多个 JSON、版本缺失及 commit 不匹配不得自动修复放行', () => {
  const json = JSON.stringify(review());
  for (const text of [json.slice(0, -1), json + '\n' + json]) assert.throws(() => parseReleaseReview(text, targets));
  for (const mutate of [result => { delete result.version; }, result => { result.commit = 'c'.repeat(40); }]) {
    const result = review();
    mutate(result);
    assert.throws(() => parseReleaseReview(JSON.stringify(result), targets));
  }
});

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automatic-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'plugins.json'), JSON.stringify([plugin]));
  fs.writeFileSync(path.join(root, 'plugin_versions.json'), JSON.stringify({ schema_version: 2, plugins: [] }));
  return root;
}

test('兼容单个闭合括号类型错误，保留说明和风险中的括号及转义字符', () => {
  const expected = review();
  expected.risks = ['保留 ] } [ { 和 "引号"、反斜杠 \\'];
  const json = JSON.stringify(expected);
  // #1069：最后一个版本对象被错误地用 ] 结束。
  const wrongObject = json.slice(0, -1) + ']';
  const wrongArray = json.replace(/\]\}$/, '}}');
  for (const broken of [wrongObject, wrongArray]) {
    for (const raw of [broken, `审核完成。\n${broken}`, '```json\n' + broken + '\n```']) {
      assert.deepEqual(parseReleaseReview(raw, targets), expected);
      assert.deepEqual(isReleasePassed(parseReleaseReview(raw, targets)), false);
    }
  }
});

test('括号修复不补截断、不接受多处错误或多份结论、不绕过身份和证据校验', () => {
  const json = JSON.stringify(review());
  const broken = json.slice(0, -1) + ']';
  for (const raw of [broken.slice(0, -1), json.replace(/\]\}$/, '}]'),
    broken + '\n' + json, json + '\n' + broken,
    broken.replace(plugin.id, 'other.demo'), broken.replace(second.commit, 'c'.repeat(40))]) {
    const { result, error } = finalizeReleaseReview(raw, targets);
    assert.ok(error);
    assert.deepEqual(isReleasePassed(result), false);
  }
  for (const field of ['summary', 'reviewed', 'risks']) {
    const incomplete = review();
    delete incomplete[field];
    const raw = JSON.stringify(incomplete).slice(0, -1) + ']';
    assert.deepEqual(isReleasePassed(parseReleaseReview(raw, targets)), false);
  }
});

test('非法 JSON、协议错误、身份错误和多份结论转人工，不使用无效通过结果', () => {
  const json = JSON.stringify(review());
  const invalid = review();
  invalid.plugin_id = 'placeholder';
  for (const raw of [json.slice(0, -1), json + json, JSON.stringify(invalid),
    json.replace('已检查源码与变更，未发现风险。', '返回值 {"success","content"}'),
    JSON.stringify({ ...review(), schema_version: 99 })]) {
    const { result, error } = finalizeReleaseReview(raw, targets);
    assert.ok(error);
    assert.deepEqual(isReleasePassed(result), false);
    assert.equal(result.commit, targets.commit);
    assert.ok(!result.reviewed && result.decision === 'manual_review' && result.risks.length);
    assert.match(renderReleaseReview(result, targets), /codex-review-raw.md/);
  }
  assert.deepEqual(finalizeReleaseReview(json, targets), { result: review(), error: null });
});

test('格式错误的审核经自动收录链路处理后保留版本给人工，索引不变', async t => {
  const root = workspace(t);
  const file = path.join(root, 'plugin_versions.json');
  const before = fs.readFileSync(file, 'utf8');
  const { result } = finalizeReleaseReview(JSON.stringify(review()).slice(0, -1), targets);
  const outcome = await applyReleaseReview({ root, issue, result, target: targets,
    request: async () => assert.fail('不能请求收录'), botLogin: 'mai[bot]' });
  assert.deepEqual(outcome, { version: '2.0.0', approved: false });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('工作流校验入口保存原始输出并生成可发布的人工处理报告', t => {
  const root = workspace(t);
  const raw = JSON.stringify(review()).slice(0, -1);
  fs.writeFileSync(path.join(root, 'mai-release-target.json'), JSON.stringify(targets));
  fs.writeFileSync(path.join(root, 'codex-review.md'), raw);
  execFileSync(process.execPath, [path.join(__dirname, 'release_review_result.cjs')], { cwd: root, stdio: 'pipe' });
  assert.equal(fs.readFileSync(path.join(root, 'codex-review-raw.md'), 'utf8'), raw);
  const result = JSON.parse(fs.readFileSync(path.join(root, 'release-review.json'), 'utf8'));
  validateReleaseReview(result, targets);
  assert.deepEqual(isReleasePassed(result), false);
  assert.match(fs.readFileSync(path.join(root, 'codex-review.md'), 'utf8'), /需人工处理/);
});

function request(url) {
  if (url.includes('/contents/?ref=')) return Promise.resolve([]);
  if (url.includes('/releases?')) return Promise.resolve([{ tag_name: targets.tag, draft: false }]);
  const release = [targets].find(item => url.endsWith(item.tag) || url.endsWith(item.commit));
  assert.ok(release);
  if (url.includes('/git/ref/')) return Promise.resolve({ object: { type: 'commit', sha: release.commit } });
  const manifest = { manifest_version: 2, id: plugin.id, version: release.version, name: 'demo', description: 'demo', license: 'MIT',
    author: { name: 'example', url: 'https://github.com/example' }, urls: { repository: plugin.repositoryUrl }, capabilities: [], i18n: { default_locale: 'zh-CN' },
    host_application: { min_version: '1.0.0' }, sdk: { min_version: '2.0.0' } };
  return Promise.resolve({ type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(manifest)).toString('base64') });
}

test('单版本通过自动收录，有风险则保留人工且不写拒绝记录', async t => {
  for (const pass of [false, true]) {
    const root = workspace(t);
    const result = review();
    if (!pass) result.risks = ['待确认的风险'];
    const outcome = await applyReleaseReview({ root, issue, result, target: targets, request, botLogin: 'mai[bot]' });
    assert.deepEqual(outcome, { version: second.version, approved: pass });
    assert.equal(fs.existsSync(path.join(root, 'blocked_release_versions.json')), false);
    const index = JSON.parse(fs.readFileSync(path.join(root, 'plugin_versions.json')));
    assert.deepEqual(index.plugins.flatMap(plugin => plugin.versions.map(item => item.version)), pass ? [second.version] : []);
  }
});

test('审核对象修改、已拒绝或已关闭的审核单不会自动放行', async t => {
  const root = workspace(t);
  const changed = { ...targets, commit: 'c'.repeat(40) };
  for (const current of [
    { ...issue, body: `<!-- plugin-release: ${JSON.stringify(changed)} -->` },
    { ...issue, state: 'closed' },
    { ...issue, body: issue.body + '\n<!-- plugin-release-superseded: 99 -->' },
    { ...issue, labels: [...issue.labels, { name: 'rejected' }] },
    { ...issue, user: { login: 'attacker' } },
  ]) {
    await assert.rejects(applyReleaseReview({ root, issue: current, result: review(), target: targets, request, botLogin: 'mai[bot]' }));
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'plugin_versions.json'))).plugins, []);
});

test('自动批准时 Tag 移动不会写入索引', async t => {
  const root = workspace(t);
  const file = path.join(root, 'plugin_versions.json');
  const before = fs.readFileSync(file, 'utf8');
  await assert.rejects(applyReleaseReview({ root, issue, result: review(), target: targets, botLogin: 'mai[bot]',
    request: async url => url.includes('/git/ref/') && url.endsWith(second.tag)
      ? { object: { type: 'commit', sha: first.commit } } : request(url) }));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
