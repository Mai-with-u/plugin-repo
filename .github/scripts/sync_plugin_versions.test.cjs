const assert = require('node:assert/strict');
const { test } = require('node:test');
const { compareVersions, skipConflictingPlugins, syncPlugin, validateManifest } = require('./sync_plugin_versions.cjs');

const plugin = { id: 'legacy.demo', repositoryUrl: 'https://github.com/example/demo' };
const commit = 'a'.repeat(40);
function manifest(version = '1.0.0') {
  return {
    manifest_version: 2, id: 'example.demo', version, name: '示例', description: '示例插件',
    author: { name: '作者' }, license: 'MIT', urls: { repository: plugin.repositoryUrl },
    host_application: { min_version: '1.0.0', max_version: '1.9.99' },
    sdk: { min_version: '2.0.0', max_version: '2.99.99' },
    capabilities: [], i18n: { default_locale: 'zh-CN' },
  };
}
function release(version = '1.0.0') {
  return { tag_name: `v${version}`, draft: false, prerelease: false, published_at: '2026-09-15T00:00:00Z' };
}
function client(releases, options = {}) {
  return async url => {
    if (url.includes('/releases?')) return releases;
    if (url.includes('/git/ref/tags/')) return { object: { type: options.annotated ? 'tag' : 'commit', sha: options.commit || commit } };
    if (url.includes('/git/tags/')) return { object: { type: 'commit', sha: commit } };
    if (url.includes('/contents/')) {
      assert.ok(url.endsWith(`ref=${commit}`));
      return { type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(options.manifest || manifest())).toString('base64') };
    }
    throw new Error(`未知请求：${url}`);
  };
}

test('版本按数字排序，不按字符串或发布时间排序', () => {
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
  assert.throws(() => compareVersions('01.0.0', '1.0.0'));
});
test('从注解 Tag 解析完整 commit 并读取该 commit 的 manifest', async () => {
  const result = await syncPlugin(plugin, undefined, client([release()], { annotated: true }), 'example.demo');
  assert.equal(result.mode, 'releases');
  assert.equal(result.manifest_id, 'example.demo');
  assert.equal(result.versions[0].commit, commit);
  assert.deepEqual(result.versions[0].manifest, manifest());
});
test('同版本重打 Tag 必须报错，旧快照保持不变', async () => {
  const old = await syncPlugin(plugin, undefined, client([release()]));
  await assert.rejects(syncPlugin(plugin, old, client([release()], { commit: 'b'.repeat(40) })), /commit 被修改/);
  assert.equal(old.versions[0].commit, commit);
});
test('删除 Release 保留历史版本并标记撤回，重新发布恢复可用', async () => {
  const old = await syncPlugin(plugin, undefined, client([release()]));
  const yanked = await syncPlugin(plugin, old, client([]));
  assert.equal(yanked.versions[0].yanked, true);
  assert.equal(yanked.mode, 'releases');
  const restored = await syncPlugin(plugin, yanked, client([release()]));
  assert.equal(restored.versions[0].yanked, false);
});
test('没有正式版本时显式使用分支模式；不把 API 错误当作没有 Release', async () => {
  const result = await syncPlugin(plugin, undefined, client([{ ...release(), tag_name: 'nightly' }]));
  assert.equal(result.mode, 'branch');
  assert.deepEqual(result.ignored_tags, ['nightly']);
  await assert.rejects(syncPlugin(plugin, undefined, async () => { throw new Error('GitHub 403'); }), /403/);
});
test('manifest 版本、身份、范围错误均阻止收录', () => {
  assert.throws(() => validateManifest(manifest(), '2.0.0', 'example.demo'), /version 不一致/);
  assert.throws(() => validateManifest(manifest(), '1.0.0', 'other.demo'), /插件 ID/);
  const invalid = manifest();
  invalid.sdk.max_version = '1.0.0';
  assert.throws(() => validateManifest(invalid, '1.0.0'), /倒置/);
});
test('重复版本标签冲突不能静默覆盖', async () => {
  await assert.rejects(syncPlugin(plugin, undefined, client([release(), { ...release(), tag_name: '1.0.0' }])), /同一版本/);
});
test('Release 分页取全，草稿不进入索引', async () => {
  const pages = [];
  const result = await syncPlugin(plugin, undefined, async url => {
    pages.push(url);
    return url.endsWith('page=1') ? Array.from({ length: 100 }, () => ({ draft: true })) : [];
  });
  assert.equal(pages.length, 2);
  assert.deepEqual(result.versions, []);
});
test('历史格式错误隔离，不能退回分支安装', async () => {
  const result = await syncPlugin(plugin, undefined, client([release()], { manifest: manifest('2.0.0') }));
  assert.equal(result.mode, 'releases');
  assert.equal(result.versions.length, 0);
  assert.match(result.rejected_releases[0].error, /version 不一致/);
});
test('目标 commit 缺少 manifest 属于发布错误，服务器故障仍然抛出', async () => {
  const base = client([release()]);
  const request = status => async url => {
    if (!url.includes('/contents/')) return base(url);
    const error = new Error(`GitHub ${status}`);
    error.status = status;
    throw error;
  };
  const result = await syncPlugin(plugin, undefined, request(404));
  assert.equal(result.rejected_releases.length, 1);
  assert.equal(result.mode, 'releases');
  await assert.rejects(syncPlugin(plugin, undefined, request(500)), /500/);
});

test('插件 ID 或 manifest ID 冲突时跳过后续条目', () => {
  const warnings = [];
  const plugins = [
    { id: 'legacy.demo', manifest_id: 'Example.Demo' },
    { id: 'example.demo', manifest_id: 'example.demo-v2' },
    { id: 'legacy.DEMO', manifest_id: 'another.demo' },
    { id: 'unique.demo', manifest_id: 'unique.demo' },
  ];
  assert.deepEqual(skipConflictingPlugins(plugins, message => warnings.push(message)), [plugins[0], plugins[3]]);
  assert.equal(warnings.length, 2);
});
