const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const normalize = url => url.replace(/\/$/, '').replace(/\.git$/, '').toLowerCase();
const FILES = ['plugins.json', 'plugin_versions.json', 'plugin_details.json', 'blocked_release_versions.json'];

async function migratePlugin({ root, currentPluginId, pluginId = currentPluginId, repoUrl, request }) {
  const data = Object.fromEntries(FILES.map(file => [file, JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))]));
  const plugins = data['plugins.json'];
  const plugin = plugins.find(item => item.id === currentPluginId);
  assert.ok(plugin, `插件 ID 不存在: ${currentPluginId}`);
  assert.match(pluginId, /^[\w.-]+$/, '插件 ID 无效');
  const destination = repoUrl || plugin.repositoryUrl;
  assert.match(destination, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/, '仓库地址无效');
  assert.ok(pluginId !== currentPluginId || destination !== plugin.repositoryUrl, '未检测到修改内容');
  assert.ok(!plugins.some(item => item !== plugin && [item.id, ...(item.aliases || [])].some(id => id.toLowerCase() === pluginId.toLowerCase())), '新插件 ID 已存在或已被历史身份占用');
  assert.ok(!plugins.some(item => item !== plugin && normalize(item.repositoryUrl) === normalize(destination)), '仓库 URL 已存在');
  const index = data['plugin_versions.json'];
  assert.equal(index.schema_version, 1);
  assert.ok(!index.plugins.some(item => item.id !== currentPluginId && [item.id, item.manifest_id].some(id => id?.toLowerCase() === pluginId.toLowerCase())), '新 ID 与版本索引身份冲突');
  const previous = index.plugins.find(item => item.id === currentPluginId);
  const oldUrl = plugin.repositoryUrl;
  if (destination !== oldUrl) {
    const base = '/repos/' + destination.slice('https://github.com/'.length).replace(/\/$/, '').replace(/\.git$/, '');
    const repository = await request(base);
    assert.ok(Number.isSafeInteger(repository.id) && repository.id > 0 && repository.private === false, '目标必须是公开仓库');
    // 即使是不同仓库，维护者批准迁移也必须保留所有历史 commit 的可访问性。
    for (const version of previous?.versions || []) {
      const commit = await request(`${base}/commits/${version.commit}`);
      assert.equal(commit.sha, version.commit, `目标仓库缺少历史 commit: ${version.commit}`);
    }
    plugin.repositoryId = repository.id;
  }
  plugin.id = pluginId;
  plugin.repositoryUrl = destination;
  if (pluginId !== currentPluginId) plugin.aliases = [...new Set([...(plugin.aliases || []), currentPluginId])].filter(id => id !== pluginId);
  if (previous) {
    previous.id = pluginId;
    previous.repositoryUrl = destination;
    if (pluginId !== currentPluginId) previous.manifest_id = pluginId;
    // 历史 manifest、tag、commit、审核信息及 release_url 原样保留。
  }
  for (const detail of data['plugin_details.json']) {
    if (detail.id === currentPluginId) detail.id = pluginId;
  }
  const blocked = data['blocked_release_versions.json'];
  for (const entry of [...blocked]) {
    if (entry.id !== currentPluginId || normalize(entry.repositoryUrl) !== normalize(oldUrl)) continue;
    if (!blocked.some(item => item.id === pluginId && normalize(item.repositoryUrl) === normalize(destination) && item.version === entry.version)) {
      blocked.push({ ...entry, id: pluginId, repositoryUrl: destination });
    }
  }
  // 全部检查通过后才落盘；工作流将四个文件作为一个 Git commit 发布。
  for (const file of FILES) fs.writeFileSync(path.join(root, file), JSON.stringify(data[file], null, 2) + '\n');
}
module.exports = { migratePlugin, FILES };
