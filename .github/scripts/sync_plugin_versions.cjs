const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[0-9a-f]{40}$/;

function compareVersions(left, right) {
  assert.match(left, VERSION, `无效版本号：${left}`);
  assert.match(right, VERSION, `无效版本号：${right}`);
  const a = left.split('.').map(BigInt);
  const b = right.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

function validateManifest(manifest, version, expectedId) {
  assert.ok(manifest && typeof manifest === 'object', 'manifest 必须是对象');
  assert.ok([1, 2].includes(manifest.manifest_version), '不支持的 manifest 协议');
  assert.equal(manifest.version, version, 'Tag 与 manifest.version 不一致');
  for (const key of ['name', 'description', 'license']) {
    assert.ok(typeof manifest[key] === 'string' && manifest[key].trim(), `缺少 ${key}`);
  }
  assert.ok(typeof manifest.author?.name === 'string' && manifest.author.name.trim(), '缺少作者名称');
  if (manifest.manifest_version === 2) {
    assert.ok(typeof manifest.id === 'string' && /^[a-zA-Z0-9_.-]+$/.test(manifest.id), '插件 ID 无效');
    if (expectedId) assert.equal(manifest.id, expectedId, '发布版本改变了插件 ID');
    assert.ok(typeof manifest.urls?.repository === 'string', '缺少 urls.repository');
    assert.ok(Array.isArray(manifest.capabilities), '缺少 capabilities');
    assert.ok(typeof manifest.i18n?.default_locale === 'string', '缺少 i18n.default_locale');
  }
  for (const field of manifest.manifest_version === 2 ? ['host_application', 'sdk'] : ['host_application']) {
    const range = manifest[field];
    assert.ok(range && typeof range.min_version === 'string', `缺少 ${field}.min_version`);
    assert.match(range.min_version, VERSION);
    if (range.max_version !== undefined) {
      assert.match(range.max_version, VERSION);
      assert.ok(compareVersions(range.min_version, range.max_version) <= 0, `${field} 版本范围倒置`);
    }
  }
}

function createGithubClient(token = process.env.GITHUB_TOKEN) {
  return async function request(resource) {
    const response = await fetch(`https://api.github.com${resource}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      const error = new Error(`GitHub ${response.status}：${resource}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  };
}

async function syncPlugin(plugin, previous, request, expectedId) {
  const match = plugin.repositoryUrl.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)\/?$/);
  assert.ok(match, `不支持的仓库地址：${plugin.repositoryUrl}`);
  const base = `/repos/${match[1]}/${match[2].replace(/\.git$/, '')}`;
  if (previous?.versions.length) {
    assert.equal(previous.repositoryUrl, plugin.repositoryUrl, '已有发布记录的仓库变更需要人工迁移');
  }
  const releases = [];
  for (let page = 1; ; page++) {
    const batch = await request(`${base}/releases?per_page=100&page=${page}`);
    assert.ok(Array.isArray(batch), 'Release 列表无效');
    releases.push(...batch.filter(release => !release.draft));
    if (batch.length < 100) break;
  }
  // 保留已发布的历史快照；远端删除的 Release 标记为撤回，不能继续推荐安装。
  const versions = new Map((previous?.versions || []).map(item => [item.version, { ...item, yanked: true }]));
  const seenVersions = new Set();
  const ignoredTags = [];
  const rejectedReleases = [];
  let manifestId = previous?.manifest_id || expectedId;
  for (const release of releases) {
    const version = release.tag_name.replace(/^v/, '');
    if (!VERSION.test(version)) {
      ignoredTags.push(release.tag_name);
      continue;
    }
    assert.ok(!seenVersions.has(version), `多个 Release 使用同一版本：${version}`);
    seenVersions.add(version);
    const tag = await request(`${base}/git/ref/tags/${encodeURIComponent(release.tag_name)}`);
    let object = tag.object;
    for (let depth = 0; object.type === 'tag'; depth++) {
      assert.ok(depth < 10, 'Tag 嵌套层级过多');
      assert.match(object.sha, SHA);
      object = (await request(`${base}/git/tags/${object.sha}`)).object;
    }
    assert.equal(object.type, 'commit', 'Tag 必须指向 commit');
    assert.match(object.sha, SHA);
    const old = versions.get(version);
    if (old) {
      assert.equal(old.commit, object.sha, `已发布版本 ${version} 的 commit 被修改`);
      assert.equal(old.tag, release.tag_name, `已发布版本 ${version} 的 Tag 被修改`);
    }
    let manifest = old?.manifest;
    try {
      if (!manifest) {
        const file = await request(`${base}/contents/_manifest.json?ref=${object.sha}`);
        assert.equal(file.type, 'file', '_manifest.json 必须是普通文件');
        assert.equal(file.encoding, 'base64');
        manifest = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
      }
      validateManifest(manifest, version, manifestId);
    } catch (error) {
      // 历史 Release 格式错误单独隔离并公开原因，不影响同插件已经验证的其他版本。
      // 已收录版本和网络故障不能按格式错误跳过，否则可能把暂时不可访问误判为撤回。
      if (old || !(error instanceof assert.AssertionError || error instanceof SyntaxError || error.status === 404)) throw error;
      rejectedReleases.push({ tag: release.tag_name, version, error: error.message });
      continue;
    }
    if (manifest.manifest_version === 2) manifestId = manifest.id;
    versions.set(version, {
      version, tag: release.tag_name, commit: object.sha,
      prerelease: Boolean(release.prerelease), yanked: false,
      published_at: release.published_at, release_url: release.html_url,
      release_notes: release.body || '', manifest,
    });
  }
  return {
    id: plugin.id, manifest_id: manifestId || plugin.id, repositoryUrl: plugin.repositoryUrl,
    mode: versions.size || rejectedReleases.length ? 'releases' : 'branch',
    versions: [...versions.values()].sort((a, b) => compareVersions(b.version, a.version)),
    ignored_tags: ignoredTags,
    rejected_releases: rejectedReleases,
  };
}

function skipConflictingPlugins(plugins, warn = console.warn) {
  const identities = new Map();
  const unique = [];
  for (const plugin of plugins) {
    const aliases = [...new Set([plugin.id, plugin.manifest_id].filter(Boolean))];
    const conflict = aliases.find(alias => identities.has(alias.toLowerCase()));
    if (conflict) {
      warn(`跳过插件 ${plugin.id}：ID ${conflict} 与 ${identities.get(conflict.toLowerCase())} 冲突`);
      continue;
    }
    unique.push(plugin);
    for (const alias of aliases) identities.set(alias.toLowerCase(), plugin.id);
  }
  return unique;
}

async function main() {
  const root = path.resolve(__dirname, '../..');
  const output = path.join(root, 'plugin_versions.json');
  const plugins = JSON.parse(fs.readFileSync(path.join(root, 'plugins.json'), 'utf8'));
  const details = JSON.parse(fs.readFileSync(path.join(root, 'plugin_details.json'), 'utf8'));
  const previous = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : { schema_version: 1, plugins: [] };
  assert.equal(previous.schema_version, 1, '不支持的版本索引协议');
  const request = createGithubClient();
  const result = [];
  let warnings = 0;
  const ids = new Set();
  const retryErrorsOnly = process.argv.includes('--retry-errors');
  for (const plugin of plugins) {
    // 与现有详情索引一致，不把登记文件中的示例占位项当成真实插件。
    if (plugin.id === 'MaiM-with-u.example-plugin1') continue;
    if (ids.has(plugin.id.toLowerCase())) {
      console.warn(`跳过重复的插件索引 ID：${plugin.id}`);
      continue;
    }
    ids.add(plugin.id.toLowerCase());
    const old = previous.plugins.find(item => item.id === plugin.id);
    if (retryErrorsOnly && old && !old.sync_error && !old.rejected_releases?.length) {
      result.push(old);
      continue;
    }
    try {
      const expectedId = details.find(item => item.id === plugin.id)?.manifest?.id;
      const synced = await syncPlugin(plugin, old, request, expectedId);
      result.push(synced);
      if (synced.rejected_releases.length) {
        warnings++;
        console.warn(`插件 ${plugin.id} 有 ${synced.rejected_releases.length} 个 Release 校验失败，详见索引 rejected_releases`);
      }
      console.log(`已同步：${plugin.id}`);
    } catch (error) {
      warnings++;
      console.warn(`跳过插件 ${plugin.id} 的本次同步：${error.message}`);
      // 错误显式进入索引，客户端必须停止安装该项；不能把失败误认为没有 Release。
      result.push({
        ...(old || { id: plugin.id, repositoryUrl: plugin.repositoryUrl, mode: 'branch', versions: [] }),
        sync_error: error.message,
      });
    }
  }
  const uniqueResult = skipConflictingPlugins(result);
  const temporary = `${output}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ schema_version: 1, plugins: uniqueResult }, null, 2)}\n`);
  fs.renameSync(temporary, output);
  if (warnings) console.warn(`同步完成：${warnings} 个插件的异常已跳过，详情已写入版本索引`);
}

module.exports = { compareVersions, skipConflictingPlugins, syncPlugin, validateManifest };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
