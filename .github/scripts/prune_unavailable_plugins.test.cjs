const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { prunePlugins, repositoryState } = require('./prune_unavailable_plugins.cjs');

const url = 'https://github.com/owner/plugin';
const fail = status => async () => { throw Object.assign(new Error(`HTTP ${status}`), { status }); };
const publicRepo = async () => ({ private: false });

test('工作流先清理再生成索引，并提交活动登记和归档文件', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../workflows/plugin-index.yml'), 'utf8');
  const cleanup = workflow.indexOf('run: node .github/scripts/prune_unavailable_plugins.cjs');
  assert.ok(cleanup > 0);
  assert.ok(cleanup < workflow.indexOf('- name: Generate plugin details'));
  assert.ok(cleanup < workflow.indexOf('- name: Synchronize releases'));
  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ github.token \}\}/);
  assert.match(workflow, /git add plugins.json archived_plugins.json plugin_details.json plugin_versions.json icons/);
});

test('公开仓库及 GitHub 重定向后的仓库保留，不探测分支或 manifest', async () => {
  const calls = [];
  const state = await repositoryState(`${url}.git/`, async resource => {
    calls.push(resource);
    return { private: false, full_name: 'new-owner/new-name' };
  }, () => assert.fail('公开仓库不应匿名复核'));
  assert.equal(state.status, 'public');
  assert.deepEqual(calls, ['/repos/owner/plugin']);
});

test('404/410 必须经匿名请求再次确认；私有仓库也检查公开可访问性', async () => {
  for (const first of [fail(404), fail(410), async () => ({ private: true })]) {
    for (const status of [404, 410]) {
      assert.equal((await repositoryState(url, first, fail(status))).status, 'unavailable');
    }
    assert.equal((await repositoryState(url, first, publicRepo)).status, 'public');
  }
});

test('限流、权限、服务错误及超时均保留，包括复核阶段', async () => {
  const failures = [401, 403, 429, 500, 502, 503, undefined];
  for (const status of failures) {
    assert.equal((await repositoryState(url, fail(status), () => assert.fail('首次异常不应归档'))).status, 'unknown');
    assert.equal((await repositoryState(url, fail(404), fail(status))).status, 'unknown');
  }
});

test('无效地址与无效元数据不会移除', async () => {
  assert.equal((await repositoryState('https://example.com/o/r', publicRepo, publicRepo)).status, 'unknown');
  assert.equal((await repositoryState(url, async () => ({}), publicRepo)).status, 'unknown');
  assert.equal((await repositoryState(url, fail(404), async () => ({}))).status, 'unknown');
});

test('归档同步清理三个索引，保留历史及快照，跳过示例，不修改原输入', async () => {
  const plugin = { id: 'gone', repositoryUrl: url };
  const detail = { id: 'gone', manifest: { name: '旧插件' } };
  const version = { id: 'gone', versions: [{ commit: '审核过的 SHA' }] };
  const plugins = [{ id: 'MaiM-with-u.example-plugin1', repositoryUrl: 'example' }, plugin,
    { id: 'active', repositoryUrl: 'https://github.com/owner/active' }];
  const input = { plugins, details: [detail, { id: 'active' }],
    versions: { schema_version: 1, plugins: [version, { id: 'active' }] }, archived: [{ id: 'history' }] };
  const copy = structuredClone(input);
  const result = await prunePlugins({ ...input, request: async resource => {
    if (resource.endsWith('/active')) return { private: false };
    return fail(404)();
  }, publicRequest: fail(404), now: () => '2026-10-16T00:00:00Z' });
  assert.deepEqual(input, copy);
  assert.deepEqual(result.plugins.map(item => item.id), ['MaiM-with-u.example-plugin1', 'active']);
  assert.deepEqual(result.details, [{ id: 'active' }]);
  assert.deepEqual(result.versions.plugins, [{ id: 'active' }]);
  assert.deepEqual(result.archived[0], { id: 'history' });
  assert.deepEqual(result.archived[1].detail_snapshot, detail);
  assert.deepEqual(result.archived[1].version_index_snapshot, version);
  assert.equal(result.archived[1].archived_at, '2026-10-16T00:00:00Z');
  const again = await prunePlugins({ ...result, request: publicRepo, publicRequest: publicRepo });
  assert.deepEqual(again.archived, result.archived);
  assert.equal(again.removed.length, 0);
});

test('共享仓库只检查一次，网络异常的插件仍在所有索引中', async () => {
  const plugins = [{ id: 'a', repositoryUrl: url }, { id: 'b', repositoryUrl: `${url}.git/` }];
  let calls = 0;
  const result = await prunePlugins({ plugins, details: [{ id: 'a' }],
    versions: { schema_version: 1, plugins: [{ id: 'a' }] }, archived: [],
    request: async () => { calls++; return fail(502)(); }, publicRequest: fail(404) });
  assert.equal(calls, 1);
  assert.equal(result.warnings.length, 2);
  assert.deepEqual(result.plugins, plugins);
  assert.deepEqual(result.details, [{ id: 'a' }]);
  assert.deepEqual(result.versions.plugins, [{ id: 'a' }]);
  assert.equal(result.removed.length, 0);
});
