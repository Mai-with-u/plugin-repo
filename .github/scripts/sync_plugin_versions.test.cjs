const assert = require('node:assert/strict');
const { test } = require('node:test');
const { compareVersions, skipConflictingPlugins, syncPlugin: syncWithGate, validateManifest } = require('./sync_plugin_versions.cjs');
// 发布格式校验用例使用明确的准入许可。
const syncPlugin = (...args) => syncWithGate(...[args[0], args[1], args[2], args[3], async () => true]);

const plugin = { id: 'legacy.demo', repositoryUrl: 'https://github.com/example/demo' };
const commit = 'a'.repeat(40);
function manifest(version = '1.0.0') {
  return {
    manifest_version: 2, id: 'example.demo', version, name: '示例', description: '示例插件',
    author: { name: '作者' }, license: 'MIT', urls: { repository: plugin.repositoryUrl },
    host_application: { min_version: '1.0.0', max_version: '1.9.99' },
    sdk: { min_version: '2.0.0', max_version: '2.1.99' },
    capabilities: [], i18n: { default_locale: 'zh-CN' },
  };
}
function release(version = '1.0.0') {
  return { tag_name: `v${version}`, draft: false, prerelease: false, published_at: '2026-09-15T00:00:00Z' };
}
function client(releases, options = {}) {
  return async url => {
    if (url.includes('/contents/?ref=')) return [];
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

test('未提供准入许可的新 Release 不收录，也不能退回分支模式', async () => {
  const result = await syncWithGate(plugin, undefined, client([release()]));
  assert.equal(result.mode, 'releases');
  assert.deepEqual(result.versions, []);
});

test('Release 汇总 config.toml 和多个 manifest 问题后拒绝收录', async () => {
  const invalid = { ...manifest(), version: '99.999.0', author: null,
    host_application: { min_version: '999.0.0', max_version: '999.99.0' }, sdk: null };
  const base = client([release()], { manifest: invalid });
  const result = await syncWithGate(plugin, undefined, async url =>
    url.includes('/contents/?ref=') ? [{ name: 'config.toml' }] : base(url), undefined,
  async () => assert.fail('违规版本不能进入审核'));
  assert.deepEqual(result.versions, []);
  for (const text of ['config.toml', 'Tag 与 manifest.version 不一致', 'version 第一位', '缺少作者', 'host_application.min_version', 'host_application.max_version']) {
    assert.ok(result.rejected_releases[0].error.includes(text), text);
  }
});

test('Release 插件和宿主版本字段限制前两位 99/999，第三位不限制', () => {
  for (const field of ['version', 'host_application.min_version', 'host_application.max_version']) {
    for (const value of ['99.0.0', '999.0.0', '1.99.0', '1.999.0', '1.0.99', '1.0.999', '1.0.1000']) {
      const data = manifest();
      const [parent, key] = field.split('.');
      if (key) data[parent] = { min_version: value, max_version: value };
      else data.version = value;
      if (value.split('.').slice(0, 2).some(part => ['99', '999'].includes(part))) {
        assert.throws(() => validateManifest(data, data.version), /第一位和第二位不能填写/);
      } else assert.doesNotThrow(() => validateManifest(data, data.version));
    }
  }
});

test('新 Release 按固定 commit 检查根目录配置，违规不进入审核，接口失败不放行', async () => {
  const base = client([release()]);
  const request = async url => {
    if (url.includes('/contents/?ref=')) {
      assert.ok(url.endsWith(commit));
      return [{ name: 'config.toml', type: 'file' }];
    }
    return base(url);
  };
  const result = await syncWithGate(plugin, undefined, request, undefined, async () => assert.fail('违规版本不得进入审核'));
  assert.deepEqual(result.versions, []);
  assert.match(result.rejected_releases[0].error, /config.toml/);
  await assert.rejects(syncWithGate(plugin, undefined, async url => {
    if (url.includes('/contents/?ref=')) throw Object.assign(new Error('GitHub 403'), { status: 403 });
    return base(url);
  }), /403/);
});

test('待审新版不影响旧版，已有版本无需重复准入', async () => {
  const old = await syncPlugin(plugin, undefined, client([release()]));
  const requested = [];
  const request = async url => {
    if (url.includes('/contents/?ref=')) return [];
    if (url.includes('/releases?')) return [release('2.0.0'), release()];
    if (url.includes('/contents/')) return { type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(manifest('2.0.0'))).toString('base64') };
    return client([])(url);
  };
  const result = await syncWithGate(plugin, old, request, undefined, async (_, candidate) => {
    requested.push(candidate.version);
    return false;
  });
  assert.deepEqual(requested, ['2.0.0']);
  assert.deepEqual(result.versions.map(item => item.version), ['1.0.0']);
  assert.equal(result.versions[0].yanked, false);
});
test('从注解 Tag 解析完整 commit 并读取该 commit 的 manifest', async () => {
  const result = await syncPlugin(plugin, undefined, client([release()], { annotated: true }), 'example.demo');
  assert.equal(result.mode, 'releases');
  assert.equal(result.manifest_id, 'example.demo');
  assert.equal(result.versions[0].commit, commit);
  assert.deepEqual(result.versions[0].manifest, manifest());
});
test('同版本重打 Tag 单独撤回并记录错误，旧快照保持不变', async () => {
  const old = await syncPlugin(plugin, undefined, client([release()]));
  const result = await syncPlugin(plugin, old, client([release()], { commit: 'b'.repeat(40) }));
  assert.match(result.rejected_releases[0].error, /commit 被修改/);
  assert.deepEqual(result.versions[0], { ...old.versions[0], yanked: true });
  assert.equal(old.versions[0].commit, commit);
  assert.equal(old.versions[0].yanked, false);
});

test('旧版本 commit 或 Tag 改写不阻断新版审核及收录，并清除旧同步错误', async () => {
  const old = await syncPlugin(plugin, undefined, client([release()]));
  old.sync_error = '旧同步错误';
  for (const changedTag of [false, true]) {
    for (const approved of [false, true]) {
      const requested = [];
      const request = async url => {
    if (url.includes('/contents/?ref=')) return [];
        if (url.includes('/releases?')) return [{ ...release(), tag_name: changedTag ? '1.0.0' : 'v1.0.0' }, release('2.0.0')];
        if (url.includes('/git/ref/tags/') && url.endsWith('1.0.0')) return { object: { type: 'commit', sha: changedTag ? commit : 'b'.repeat(40) } };
        return client([], { manifest: manifest('2.0.0') })(url);
      };
      const result = await syncWithGate(plugin, old, request, undefined, async (_, candidate) => {
        requested.push(candidate.version);
        return approved;
      });
      assert.deepEqual(requested, ['2.0.0']);
      assert.equal(result.sync_error, undefined);
      assert.match(result.rejected_releases[0].error, changedTag ? /Tag 被修改/ : /commit 被修改/);
      assert.equal(result.versions.find(item => item.version === '1.0.0').yanked, true);
      assert.equal(result.versions.some(item => item.version === '2.0.0' && !item.yanked), approved);
    }
  }
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
  invalid.host_application.max_version = '0.9.0';
  assert.throws(() => validateManifest(invalid, '1.0.0'), /倒置/);
});
test('重复版本标签冲突不能静默覆盖', async () => {
  await assert.rejects(syncPlugin(plugin, undefined, client([release(), { ...release(), tag_name: '1.0.0' }])), /同一版本/);
});
test('Release 分页取全，草稿不进入索引', async () => {
  const pages = [];
  const result = await syncPlugin(plugin, undefined, async url => {
    if (url.includes('/contents/?ref=')) return [];
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
    if (url.includes('/contents/?ref=')) return [];
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


test('改 ID 后历史快照及审核信息保留，新版按新身份收录', async () => {
  const previous = await syncPlugin(plugin, undefined, client([release()]));
  previous.versions[0].review = { decision: 'approve', issue: 123 };
  const snapshot = structuredClone(previous.versions[0]);
  previous.id = 'new.demo';
  previous.manifest_id = 'new.demo';
  const result = await syncPlugin({ ...plugin, id: 'new.demo' }, previous,
    client([release('2.0.0'), release()], { manifest: { ...manifest('2.0.0'), id: 'new.demo' } }));
  assert.equal(result.manifest_id, 'new.demo');
  assert.deepEqual(result.versions.find(item => item.version === '1.0.0'), snapshot);
  assert.equal(result.versions.length, 2);
});


test('Release 不校验 SDK 版本范围，保留声明并重新处理此前被拒的版本', async () => {
  for (const sdk of [{ min_version: '2.19.0', max_version: '2.99.99' },
    { min_version: '3.0.0', max_version: '1.0.0' }, { min_version: 'invalid' }]) {
    const data = { ...manifest(), sdk };
    const previous = { ...plugin, mode: 'releases', versions: [],
      rejected_releases: [{ tag: 'v1.0.0', version: '1.0.0', error: 'sdk.max_version 第一位和第二位不能填写 99 或 999' }] };
    const result = await syncPlugin(plugin, previous, client([release()], { manifest: data }));
    assert.equal(result.versions.length, 1);
    assert.deepEqual(result.versions[0].manifest.sdk, sdk);
    assert.deepEqual(result.rejected_releases, []);
  }
});
