const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createGithubClient } = require('./sync_plugin_versions.cjs');

const EXAMPLE_ID = 'MaiM-with-u.example-plugin1';
const UNAVAILABLE = new Set([404, 410]);

async function repositoryState(repositoryUrl, request, publicRequest) {
  const match = repositoryUrl?.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)\/?$/);
  if (!match) return { status: 'unknown', reason: '不支持的仓库地址，保留登记' };
  const resource = `/repos/${match[1]}/${match[2].replace(/\.git$/, '')}`;
  try {
    const repo = await request(resource);
    if (repo.private === false) return { status: 'public' };
    if (repo.private !== true) return { status: 'unknown', reason: '仓库元数据无效，保留登记' };
  } catch (error) {
    if (!UNAVAILABLE.has(error.status)) return { status: 'unknown', reason: error.message };
  }
  // 只检查仓库元数据，不用某个分支、manifest 或 Release 的 404 判断仓库失效。
  // 以不带凭据的第二次请求确认公开可访问性，避免令牌可见范围影响判断。
  try {
    const repo = await publicRequest(resource);
    if (repo.private === false) return { status: 'public' };
    return { status: 'unknown', reason: '公开访问复核结果异常，保留登记' };
  } catch (error) {
    if (!UNAVAILABLE.has(error.status)) return { status: 'unknown', reason: `公开访问复核失败：${error.message}` };
    return { status: 'unavailable', reason: '源仓库无法公开访问，仓库 API 两次检查确认（404/410），可能已删除、转为私有或地址失效' };
  }
}

async function prunePlugins({ plugins, details, versions, archived, request, publicRequest,
  now = () => new Date().toISOString(), onProgress = () => {} }) {
  assert.ok(Array.isArray(plugins) && Array.isArray(details) && Array.isArray(archived), '索引必须为数组');
  assert.equal(versions.schema_version, 1, '不支持的版本索引协议');
  assert.ok(Array.isArray(versions.plugins), '版本索引无效');
  const states = new Map();
  const removed = [];
  const warnings = [];
  const active = [];
  const candidates = plugins.filter(plugin => plugin.id !== EXAMPLE_ID);
  const keyOf = plugin => plugin.repositoryUrl?.replace(/\/$/, '').replace(/\.git$/, '').toLowerCase();
  let next = 0;
  let checked = 0;
  // 限制为四个并发；共享仓库复用同一个检查，输出仍按原登记顺序排列。
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
    while (next < candidates.length) {
      const plugin = candidates[next++];
      const key = keyOf(plugin);
      if (!states.has(key)) states.set(key, repositoryState(plugin.repositoryUrl, request, publicRequest));
      await states.get(key);
      onProgress(++checked, candidates.length);
    }
  }));
  for (const plugin of plugins) {
    if (plugin.id === EXAMPLE_ID) {
      active.push(plugin);
      continue;
    }
    const state = await states.get(keyOf(plugin));
    if (state.status !== 'unavailable') {
      active.push(plugin);
      if (state.status === 'unknown') warnings.push({ id: plugin.id, reason: state.reason });
      continue;
    }
    removed.push({ ...plugin, archived_at: now(), checked_at: now(), archive_reason: state.reason,
      detail_snapshot: details.find(item => item.id === plugin.id) || null,
      version_index_snapshot: versions.plugins.find(item => item.id === plugin.id) || null });
  }
  const removedIds = new Set(removed.map(item => item.id));
  return { plugins: active, details: details.filter(item => !removedIds.has(item.id)),
    versions: { ...versions, plugins: versions.plugins.filter(item => !removedIds.has(item.id)) },
    archived: [...archived, ...removed], removed, warnings };
}

async function main() {
  const root = path.resolve(__dirname, '../..');
  const dryRun = process.argv.includes('--dry-run');
  assert.ok(process.argv.slice(2).every(arg => arg === '--dry-run'), '仅支持 --dry-run 参数');
  const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  // 工作流必须使用 token，避免几百个元数据请求耗尽匿名 API 额度。
  assert.ok(process.env.GITHUB_TOKEN, '必须配置 GITHUB_TOKEN');
  const result = await prunePlugins({ plugins: read('plugins.json'), details: read('plugin_details.json'),
    versions: read('plugin_versions.json'), archived: read('archived_plugins.json'),
    request: createGithubClient(), publicRequest: createGithubClient(''),
    onProgress: (checked, total) => {
      if (checked % 50 === 0 || checked === total) console.log(`已检查 ${checked}/${total} 个插件仓库`);
    } });
  for (const plugin of result.removed) console.log(`归档失效插件：${plugin.id} ${plugin.repositoryUrl}`);
  for (const warning of result.warnings) console.warn(`保留插件 ${warning.id}：${warning.reason}`);
  console.log(`${dryRun ? '预览' : '清理'}完成：归档 ${result.removed.length} 项，检查异常保留 ${result.warnings.length} 项`);
  if (!dryRun && result.removed.length) {
    for (const [file, data] of Object.entries({ 'plugins.json': result.plugins, 'plugin_details.json': result.details,
      'plugin_versions.json': result.versions, 'archived_plugins.json': result.archived })) {
      fs.writeFileSync(path.join(root, file), `${JSON.stringify(data, null, 2)}\n`);
    }
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const escape = value => String(value).replace(/[\r\n|`<>]/g, ' ');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `\n### 失效仓库清理\n\n归档 ${result.removed.length} 项；检查异常保留 ${result.warnings.length} 项。\n\n` +
      result.removed.map(item => `- ${escape(item.id)}：${escape(item.repositoryUrl)}\n`).join('') +
      result.warnings.map(item => `- 保留 ${escape(item.id)}：${escape(item.reason)}\n`).join(''));
  }
}

module.exports = { prunePlugins, repositoryState };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
