const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createReleaseGate, approveRelease, parseReleaseIssue } = require('./release_review.cjs');

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
  assert.equal(await gate(plugin, candidate), false);
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0][1].labels, ['plugin-release']);
  assert.deepEqual(posts[1][1].labels, ['validated']);
  assert.deepEqual(parseReleaseIssue({ body: posts[0][1].body }), data);
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
  assert.equal(posts, 1);
});
