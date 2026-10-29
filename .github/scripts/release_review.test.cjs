const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createReleaseGate, approveRelease, parseReleaseIssue } = require('./release_review.cjs');
const { approveReleaseCommand, rejectReleaseCommand } = require('./release_commands.cjs');

const plugin = { id: 'example.demo', repositoryUrl: 'https://github.com/example/demo' };
const candidate = { version: '1.0.0', tag: 'v1.0.0', commit: 'a'.repeat(40) };
const data = { ...plugin, ...candidate };
const botLogin = 'mai[bot]';
const issue = (extra = {}) => ({ number: 8, user: { login: botLogin }, state: 'open',
  labels: [{ name: 'validated' }], body: `<!-- plugin-release: ${JSON.stringify(data)} -->`, ...extra });

function workspace(t, trusted = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'trusted_developers.json'), JSON.stringify(trusted));
  fs.writeFileSync(path.join(root, 'plugins.json'), JSON.stringify([plugin]));
  fs.writeFileSync(path.join(root, 'plugin_versions.json'), JSON.stringify({ schema_version: 1, plugins: [] }));
  return root;
}

test('已拒绝 Issue 的历史版本按版本号去重，同版本换 commit 不重新开单', async t => {
  const root = workspace(t);
  const rejected = issue({ state: 'closed', labels: [{ name: 'rejected' }] });
  const request = async url => {
    if (url.includes('/contents/?ref=')) return [];
    assert.ok(url.includes('/issues?'), '永久拒绝版本不需要查询授信或重新开单');
    return [rejected];
  };
  const gate = await createReleaseGate({ root, request, repository: 'market/repo', botLogin });
  assert.equal(await gate(plugin, { ...candidate, commit: 'c'.repeat(40) }), false);
  await gate.flush(plugin);
});

test('分页读取并去重全部状态 Issue，关闭并不自动准入', async t => {
  const root = workspace(t);
  const calls = [];
  const request = async (url, init) => {
    calls.push([url, init]);
    if (url.includes('/issues?')) return url.endsWith('page=1')
      ? Array.from({ length: 100 }, () => issue({ body: '' })) : [issue({ state: 'closed' })];
    if (url === '/repos/example/demo') return { owner: { id: 10 }, full_name: 'example/demo' };
    throw new Error(url);
  };
  const gate = await createReleaseGate({ root, request, repository: 'market/repo', botLogin });
  assert.equal(await gate(plugin, candidate), false);
  assert.equal(calls.filter(([url]) => url.includes('/issues?')).length, 2);
  assert.equal(calls.some(([, init]) => init?.method === 'POST'), false);
});

test('新发布只创建一次 Issue，再添加 validated 触发审核；伪造作者不参与去重', async t => {
  const root = workspace(t);
  const posts = [];
  const request = async (url, init) => {
    if (init) { posts.push([url, JSON.parse(init.body)]); return issue({ labels: [{ name: 'plugin-release' }] }); }
    if (url.includes('/issues?')) return [issue({ user: { login: 'attacker' } })];
    return { owner: { id: 10 }, full_name: 'example/demo' };
  };
  const gate = await createReleaseGate({ root, request, repository: 'market/repo', botLogin });
  assert.equal(await gate(plugin, candidate), false);
  await gate.flush(plugin);
  assert.equal(await gate(plugin, candidate), false);
  await gate.flush(plugin);
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0][1].labels, ['plugin-release']);
  assert.deepEqual(posts[1][1].labels, ['validated']);
  assert.deepEqual(parseReleaseIssue({ body: posts[0][1].body }), { ...data, discarded: [], base_commit: null });
});

test('授信同时要求数字 owner ID 和授权仓库匹配', async t => {
  const root = workspace(t, [{ owner_id: 10, repositories: ['example/demo'] }]);
  let ownerId = 10;
  const request = async (url, init) => init ? issue() : url.includes('/issues?') ? [] : { owner: { id: ownerId }, full_name: url.slice('/repos/'.length) };
  const gate = await createReleaseGate({ root, request, repository: 'market/repo', botLogin });
  assert.equal(await gate(plugin, candidate), true);
  ownerId = 11;
  const transferred = await createReleaseGate({ root, request, repository: 'market/repo', botLogin });
  assert.equal(await transferred(plugin, candidate), false);
  ownerId = 10;
  assert.equal(await gate({ ...plugin, repositoryUrl: 'https://github.com/example/other' }, candidate), false);
});

function releaseClient(commit = candidate.commit, releases = [candidate.tag]) {
  return async url => {
    if (url.includes('/contents/?ref=')) return [];
    if (url.includes('/releases?')) return releases.map(tag_name => ({ tag_name, draft: false }));
    if (url.includes('/git/ref/')) return { object: { type: 'commit', sha: commit } };
    if (url.includes('/contents/')) return { type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify({
      manifest_version: 2, id: plugin.id, version: candidate.version, name: 'demo', description: 'demo',
      license: 'MIT', author: { name: 'example' }, urls: { repository: plugin.repositoryUrl },
      capabilities: [], i18n: { default_locale: 'zh-CN' }, host_application: { min_version: '1.0.0' }, sdk: { min_version: '2.0.0' },
    })).toString('base64') };
    throw new Error(url);
  };
}

test('批准固定 commit 写入版本索引，Tag 移动或撤回不写入', async t => {
  const root = workspace(t);
  const file = path.join(root, 'plugin_versions.json');
  const before = fs.readFileSync(file, 'utf8');
  for (const request of [releaseClient('b'.repeat(40)), releaseClient(candidate.commit, [])]) {
    await assert.rejects(approveRelease({ root, issue: issue(), request, botLogin }), /重新审核/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
  await approveRelease({ root, issue: issue(), request: releaseClient(), botLogin });
  assert.equal(JSON.parse(fs.readFileSync(file)).plugins[0].versions[0].commit, candidate.commit);
});

test('伪造作者、关闭 Issue 和登记仓库变更均阻止批准', async t => {
  const root = workspace(t);
  for (const target of [issue({ user: { login: 'attacker' } }), issue({ state: 'closed' })]) {
    await assert.rejects(approveRelease({ root, issue: target, request: releaseClient(), botLogin }));
  }
  fs.writeFileSync(path.join(root, 'plugins.json'), JSON.stringify([{ ...plugin, repositoryUrl: 'https://github.com/other/demo' }]));
  await assert.rejects(approveRelease({ root, issue: issue(), request: releaseClient(), botLogin }), /登记信息/);
});

test('批准一个发布版本不会顺带收录其他待审版本', async t => {
  const root = workspace(t);
  const request = async url => {
    if (url.includes('/contents/?ref=')) return [];
    if (url.includes('/releases?')) return [{ tag_name: 'v2.0.0', draft: false }, { tag_name: candidate.tag, draft: false }];
    if (url.includes('/git/ref/') && url.endsWith('v2.0.0')) return { object: { type: 'commit', sha: 'b'.repeat(40) } };
    const result = await releaseClient()(url);
    if (url.includes('/contents/') && url.endsWith('b'.repeat(40))) {
      const manifest = JSON.parse(Buffer.from(result.content, 'base64').toString());
      manifest.version = '2.0.0';
      result.content = Buffer.from(JSON.stringify(manifest)).toString('base64');
    }
    return result;
  };
  await approveRelease({ root, issue: issue(), request, botLogin });
  const index = JSON.parse(fs.readFileSync(path.join(root, 'plugin_versions.json')));
  assert.deepEqual(index.plugins[0].versions.map(item => item.version), ['1.0.0']);
});

test('开单后添加标签失败，下次巡视恢复审核触发', async t => {
  const root = workspace(t);
  const pending = issue({ labels: [{ name: 'plugin-release' }] });
  let posts = 0;
  const request = async (url, init) => {
    if (init) { posts++; assert.ok(url.endsWith('/8/labels')); return []; }
    if (url.includes('/issues?')) return [pending];
    return { owner: { id: 10 }, full_name: 'example/demo' };
  };
  const gate = await createReleaseGate({ root, request, repository: 'market/repo', botLogin });
  assert.equal(await gate(plugin, candidate), false);
  await gate.flush(plugin);
  assert.equal(posts, 1);
});

test('每次巡视只审核最新一个，重跑不补开丢弃版本，待审新发布另开审核单', async t => {
  const root = workspace(t);
  const issues = [];
  const request = async (url, init) => {
    if (!init) return url.includes('/issues?') ? issues : { owner: { id: 10 }, full_name: 'example/demo' };
    const body = JSON.parse(init.body);
    if (url.endsWith('/issues')) {
      const created = issue({ number: issues.length + 1, body: body.body, labels: [{ name: 'plugin-release' }] });
      issues.push(created);
      return created;
    }
    return [];
  };
  const candidates = Array.from({ length: 7 }, (_, index) => ({
    version: `1.0.${index}`, tag: `v1.0.${index}`, commit: String(index + 1).repeat(40),
    published_at: `2026-10-0${index + 1}T00:00:00Z`,
  }));
  const scan = async releases => {
    const gate = await createReleaseGate({ root, request, repository: 'market/repo', botLogin });
    for (const release of releases) assert.equal(await gate(plugin, release), false);
    await gate.flush(plugin);
  };
  await scan(candidates);
  assert.equal(issues.length, 1);
  const batch = parseReleaseIssue(issues[0]);
  assert.deepEqual(batch.version, '1.0.6');
  assert.deepEqual(batch.discarded.map(item => item.version), ['1.0.5', '1.0.4', '1.0.3', '1.0.2', '1.0.1', '1.0.0']);
  await scan(candidates);
  assert.equal(issues.length, 1);
  const next = { version: '1.0.7', tag: 'v1.0.7', commit: '8'.repeat(40), published_at: '2026-10-08T00:00:00Z' };
  await scan([...candidates, next]);
  assert.equal(issues.length, 2);
  assert.equal(issues[0].state, 'closed');
  assert.equal(issues[1].state, 'open');
  assert.deepEqual(parseReleaseIssue(issues[1]).version, '1.0.7');
  assert.deepEqual(parseReleaseIssue(issues[0]), batch);
  issues.forEach(item => { item.state = 'closed'; });
  await scan([...candidates, next]);
  assert.equal(issues.length, 2);
});

test('仅按发布时间而非版本号取最新，多版本目标不能批准', async t => {
  const root = workspace(t);
  let created;
  const request = async (url, init) => {
    if (!init) return url.includes('/issues?') ? [] : { owner: { id: 10 }, full_name: 'example/demo' };
    if (url.endsWith('/issues')) created = issue({ body: JSON.parse(init.body).body });
    return created;
  };
  const gate = await createReleaseGate({ root, request, repository: 'market/repo', botLogin });
  await gate(plugin, { ...candidate, version: '9.0.0', tag: 'v9.0.0', published_at: '2026-01-01' });
  await gate(plugin, { ...candidate, published_at: '2026-10-01' });
  await gate.flush(plugin);
  assert.deepEqual(parseReleaseIssue(created).version, '1.0.0');
  assert.deepEqual(parseReleaseIssue(created).discarded.map(item => item.version), ['9.0.0']);
  assert.throws(() => parseReleaseIssue(issue({ body: `<!-- plugin-release: ${JSON.stringify({ ...plugin,
    releases: Array.from({ length: 6 }, () => candidate) })} -->` })), /单个 Release/);
});

test('批准命令只接受无参数形式，拒绝不能下架已收录版本', async t => {
  const root = workspace(t);
  for (const command of ['/ap 1.0.0', '/approve 1.0.0 2.0.0', '/apple']) {
    await assert.rejects(approveReleaseCommand({ root, issue: issue(), request: releaseClient(), botLogin, command }), /不再接受版本参数/);
  }
  assert.deepEqual(await approveReleaseCommand({ root, issue: issue(), request: releaseClient(), botLogin, command: '/ap' }), { version: '1.0.0' });
  assert.throws(() => rejectReleaseCommand({ root, issue: issue(), botLogin }), /已收录/);
});

test('拒绝单版本永久生效，同版本换 commit 或授信仍不能收录', async t => {
  const root = workspace(t, [{ owner_id: 10, repositories: ['example/demo'] }]);
  for (let i = 0; i < 2; i++) assert.deepEqual(rejectReleaseCommand({ root, issue: issue(), botLogin }), { version: '1.0.0' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'blocked_release_versions.json'))).length, 1);
  await assert.rejects(approveRelease({ root, issue: issue(), request: releaseClient(), botLogin }), /永久拒绝/);
  const gate = await createReleaseGate({ root, repository: 'market/repo', botLogin, request: async url =>
    url.includes('/issues?') ? [] : { owner: { id: 10 }, full_name: 'example/demo' } });
  assert.equal(await gate(plugin, { ...candidate, commit: 'c'.repeat(40) }), false);
});

test('旧单版本 Issue 归一化，多版本只参与历史去重且不能批准', async t => {
  const root = workspace(t);
  const second = { ...candidate, version: '2.0.0', tag: 'v2.0.0' };
  const single = issue({ body: `<!-- plugin-release: ${JSON.stringify({ ...plugin, releases: [candidate] })} -->` });
  assert.deepEqual(parseReleaseIssue(single), parseReleaseIssue(issue()));
  const old = issue({ state: 'closed', body: `<!-- plugin-release: ${JSON.stringify({ ...plugin, releases: [second, candidate], discarded: [] })} -->` });
  assert.throws(() => parseReleaseIssue(old), /单个 Release/);
  await assert.rejects(approveRelease({ root, issue: { ...old, state: 'open' }, request: releaseClient(), botLogin }), /单个 Release/);
  const gate = await createReleaseGate({ root, repository: 'market/repo', botLogin, request: async (url, init) => {
    assert.equal(init, undefined, '历史版本不能重新开单');
    return url.includes('/issues?') ? [old] : { owner: { id: 10 }, full_name: 'example/demo' };
  } });
  for (const release of [candidate, second]) assert.equal(await gate(plugin, release), false);
  await gate.flush(plugin);
});

test('取代旧单可重试，隔离其他插件与伪造作者，新单创建失败不关闭旧单', async t => {
  const root = workspace(t);
  const old = issue({ number: 8 });
  const other = issue({ number: 9, body: `<!-- plugin-release: ${JSON.stringify({ ...data, id: 'other.plugin' })} -->` });
  const forged = issue({ number: 10, user: { login: 'attacker' } });
  const history = [old, other, forged];
  const calls = [];
  let failCreate = true, failClose = true;
  const request = async (url, init) => {
    if (!init) return url.includes('/issues?') ? structuredClone(history) : { owner: { id: 10 }, full_name: 'example/demo' };
    const body = JSON.parse(init.body);
    calls.push({ url, method: init.method, body });
    if (url.endsWith('/issues')) {
      if (failCreate) throw new Error('创建失败');
      const created = issue({ number: 11, body: body.body, labels: [{ name: 'plugin-release' }] });
      history.push(created);
      return structuredClone(created);
    }
    if (init.method === 'PATCH') {
      assert.equal(url, '/repos/market/repo/issues/8');
      if (failClose) throw new Error('关闭失败');
      Object.assign(old, body, { labels: body.labels.map(name => ({ name })) });
      return structuredClone(old);
    }
    assert.equal(url, '/repos/market/repo/issues/11/labels');
    history[3].labels.push({ name: 'validated' });
    return [];
  };
  const newer = { version: '2.0.0', tag: 'v2.0.0', commit: 'b'.repeat(40) };
  async function scan() {
    const gate = await createReleaseGate({ root, request, repository: 'market/repo', botLogin });
    await gate(plugin, candidate);
    await gate(plugin, newer);
    await gate.flush(plugin);
  }
  await assert.rejects(scan(), /创建失败/);
  assert.equal(old.state, 'open');
  assert.equal(calls.some(call => call.method === 'PATCH'), false);
  failCreate = false;
  await assert.rejects(scan(), /关闭失败/);
  assert.equal(history.length, 4);
  assert.equal(history[3].labels.some(label => label.name === 'validated'), false);
  failClose = false;
  await scan();
  assert.equal(history.length, 4, '恢复时不重复开单');
  assert.equal(old.state, 'closed');
  assert.equal(old.state_reason, 'not_planned');
  assert.match(old.body, /plugin-release-superseded: 11/);
  assert.equal(old.labels.some(label => label.name === 'validated'), false);
  assert.equal(other.state, 'open');
  assert.equal(forged.state, 'open');
  assert.equal(history[3].labels.some(label => label.name === 'validated'), true);
  assert.equal(fs.existsSync(path.join(root, 'blocked_release_versions.json')), false);
  const reopened = { ...old, state: 'open' };
  await assert.rejects(approveRelease({ root, issue: reopened, request: releaseClient(), botLogin }), /被新版取代/);
  assert.throws(() => rejectReleaseCommand({ root, issue: reopened, botLogin }), /被新版取代/);
  const before = calls.length;
  await scan();
  assert.equal(calls.length, before);
});

test('没有新候选时也清理遗留旧单，即使最新单已关闭', async t => {
  const root = workspace(t);
  const latest = issue({ number: 12, state: 'closed' });
  const old = issue({ number: 8 });
  const writes = [];
  const gate = await createReleaseGate({ root, repository: 'market/repo', botLogin, request: async (url, init) => {
    if (!init) return [old, latest];
    writes.push([url, JSON.parse(init.body)]);
    return {};
  } });
  await gate.flush(plugin);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], '/repos/market/repo/issues/8');
  assert.equal(writes[0][1].state, 'closed');
  assert.match(writes[0][1].body, /#12/);
});
