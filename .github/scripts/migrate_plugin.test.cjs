const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migratePlugin, FILES } = require('./migrate_plugin.cjs');
const { isBlockedRelease } = require('./release_review.cjs');
const oldUrl = 'https://github.com/old/repo';
const newUrl = 'https://github.com/new/repo';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const version = { version: '1.0.0', tag: 'v1.0.0', commit: 'a'.repeat(40), manifest: { id: 'old.plugin' }, review: { decision: 'approve' }, yanked: true };
  const data = [[{ id: 'old.plugin', repositoryUrl: oldUrl }], { schema_version: 1, plugins: [{ id: 'old.plugin', manifest_id: 'old.plugin', repositoryUrl: oldUrl, versions: [version] }] }, [{ id: 'old.plugin', manifest: { id: 'old.plugin' } }], [{ id: 'old.plugin', repositoryUrl: oldUrl, version: '2.0.0', reason: 'rejected' }]];
  FILES.forEach((file, i) => fs.writeFileSync(path.join(root, file), JSON.stringify(data[i])));
  return { root, version, read: file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')) };
}
test('迁移 ID 和仓库保留历史快照、旧封禁并封禁新身份', async t => {
  const f = fixture(t);
  await migratePlugin({ root: f.root, currentPluginId: 'old.plugin', pluginId: 'new.plugin', repoUrl: newUrl,
    request: async url => url.includes('/commits/') ? { sha: 'a'.repeat(40) } : { id: 123, private: false } });
  const plugin = f.read('plugins.json')[0];
  assert.deepEqual(plugin.aliases, ['old.plugin']);
  const index = f.read('plugin_versions.json').plugins[0];
  assert.equal(index.manifest_id, 'new.plugin');
  assert.deepEqual(index.versions, [f.version]);
  const blocked = f.read('blocked_release_versions.json');
  assert.equal(blocked.length, 2);
  assert.ok(isBlockedRelease(blocked, plugin, '2.0.0'));
  assert.equal(f.read('plugin_details.json')[0].id, 'new.plugin');
});
test('新 ID 留空时仅迁移地址', async t => {
  const f = fixture(t);
  await migratePlugin({ root: f.root, currentPluginId: 'old.plugin', repoUrl: newUrl,
    request: async url => url.includes('/commits/') ? { sha: 'a'.repeat(40) } : { id: 123, private: false } });
  assert.equal(f.read('plugin_versions.json').plugins[0].id, 'old.plugin');
});
test('目标缺少历史 commit 时所有文件不变', async t => {
  const f = fixture(t);
  const before = FILES.map(file => fs.readFileSync(path.join(f.root, file), 'utf8'));
  await assert.rejects(migratePlugin({ root: f.root, currentPluginId: 'old.plugin', repoUrl: newUrl,
    request: async url => url.includes('/commits/') ? { sha: 'b'.repeat(40) } : { id: 123, private: false } }), /历史 commit/);
  assert.deepEqual(FILES.map(file => fs.readFileSync(path.join(f.root, file), 'utf8')), before);
});
test('历史别名不能被其他插件占用', async t => {
  const f = fixture(t);
  const plugins = f.read('plugins.json');
  plugins.push({ id: 'other.plugin', aliases: ['reserved.plugin'], repositoryUrl: newUrl });
  fs.writeFileSync(path.join(f.root, 'plugins.json'), JSON.stringify(plugins));
  await assert.rejects(migratePlugin({ root: f.root, currentPluginId: 'old.plugin', pluginId: 'reserved.plugin' }), /历史身份/);
});
