const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const exec = promisify(require('node:child_process').execFile);
const { configuration, mirrorPlan, redact, gitEnvironment, apiClient, ensureRepository,
  mirrorRepository, syncPlugins, publishReport, STATUS_BRANCH, DISABLED_BUILDS } = require('./sync_cnb_mirrors.cjs');

const plugin = (id, repo = 'Owner/Plugin') => ({ id, repositoryUrl: `https://github.com/${repo}` });
const config = configuration({ CNB_GROUP: 'MaiBot/Plugins' });

test('配置校验拒绝 URL、空路径段、路径穿越和非法并发数', () => {
  assert.equal(config.group, 'maibot/plugins');
  assert.equal(config.registry, 'plugin-repo');
  for (const group of ['', 'https://cnb.cool/test', 'test//mirror', '../test', 'test.git']) {
    assert.throws(() => configuration({ CNB_GROUP: group }));
  }
  assert.throws(() => configuration({ CNB_GROUP: 'test', CNB_SYNC_CONCURRENCY: '0' }));
});

test('映射可重现、大小写及 .git 等价、长名称截断后仍区分源仓库', () => {
  const [one, two] = mirrorPlan([plugin('one'), plugin('two', 'owner/plugin.git')], config);
  assert.equal(one.mirrorPath, two.mirrorPath);
  const long = 'x'.repeat(100);
  const [a, b] = mirrorPlan([plugin('a', `owner/${long}a`), plugin('b', `owner/${long}b`)], config);
  assert.notEqual(a.mirrorPath, b.mirrorPath);
  assert.ok(a.mirrorPath.split('/').pop().length <= 64);
  assert.throws(() => mirrorPlan([{ id: 'a', repositoryUrl: 'https://example.com/a/b' }], config));
  assert.equal(mirrorPlan([plugin('MaiM-with-u.example-plugin1', 'MaiM-with-u/MaiBot'), plugin('real')], config).length, 1);
});

test('首次建仓为公开，推送前必须关闭所有构建；权限错误不当作不存在', async () => {
  const calls = [];
  const api = async (...args) => {
    calls.push(args);
    if (args.length === 1) throw Object.assign(new Error('missing'), { status: 404 });
  };
  await ensureRepository(api, 'test/mirror', 'https://github.com/owner/plugin');
  assert.deepEqual(calls, [
    ['test/mirror'],
    ['test/-/repos', 'POST', { name: 'mirror', visibility: 'public', description: 'MaiBot mirror of https://github.com/owner/plugin' }],
    ['test/mirror/-/settings/cloud-native-build', 'PUT', DISABLED_BUILDS],
  ]);
  let attempts = 0;
  await assert.rejects(ensureRepository(async () => {
    attempts++;
    throw Object.assign(new Error('forbidden'), { status: 403 });
  }, 'test/mirror', 'source'), /forbidden/);
  assert.equal(attempts, 1);
});

test('CNB API 使用 Bearer，拒绝重定向；404 返回状态码供建仓判断', async () => {
  const api = apiClient('secret', async (url, options) => {
    assert.equal(url, 'https://api.cnb.cool/test/mirror');
    assert.equal(options.headers.Authorization, 'Bearer secret');
    assert.equal(options.redirect, 'error');
    return { ok: false, status: 404 };
  });
  await assert.rejects(api('test/mirror'), error => error.status === 404);
  let attempts = 0;
  const create = apiClient('secret', async () => { attempts++; throw new Error('timeout'); });
  await assert.rejects(create('test/-/repos', 'POST', { name: 'mirror' }), /timeout/);
  assert.equal(attempts, 1, '结果未知的建仓请求不能盲目重试');
});

test('Git 凭据仅作用于 CNB，输出脱敏', () => {
  const env = gitEnvironment('secret');
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://cnb.cool/.extraheader');
  assert.equal(env.CNB_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  const encoded = Buffer.from('cnb:secret').toString('base64');
  assert.equal(redact(`secret ${encoded}`, 'secret'), '[REDACTED] [REDACTED]');
});

test('并发同步隔离失败、限制并发，并对重复仓库只同步一次', async () => {
  const plan = mirrorPlan([plugin('a'), plugin('b', 'owner/broken'), plugin('c'), plugin('d', 'owner/other')], config);
  let active = 0;
  let peak = 0;
  let calls = 0;
  const results = await syncPlugins(plan, 2, async p => {
    calls++;
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    if (p.id === 'b') throw new Error('push failed');
    return { commit: 'a'.repeat(40) };
  }, () => '2026-10-16T00:00:00Z');
  assert.equal(calls, 3);
  assert.equal(peak, 2);
  assert.deepEqual(results.map(p => p.status), ['synced', 'failed', 'synced', 'synced']);
  assert.equal(results[1].synced_at, undefined);
  assert.equal(results[1].error, 'push failed');
  assert.equal(results[2].commit, results[0].commit);
});

test('LFS 同步失败时禁止发布新的代码引用', async () => {
  const calls = [];
  await assert.rejects(mirrorRepository(async args => {
    calls.push(args);
    if (args[0] === 'symbolic-ref') return 'main';
    if (args[0] === 'lfs' && args[1] === 'push') throw new Error('LFS failed');
  }, 'source', 'mirror', 'directory'), /LFS failed/);
  assert.ok(!calls.some(args => args[0] === 'push'));
  const push = calls.findIndex(args => args[0] === 'lfs' && args[1] === 'push');
  const endpoint = calls.findIndex(args => args[0] === 'config' && args[1] === 'lfs.pushurl');
  assert.ok(endpoint >= 0 && endpoint < push);
  assert.deepEqual(calls[endpoint], ['config', 'lfs.pushurl', 'mirror.git/info/lfs']);
});

test('真实 Git 验证：保留 SHA、注解 Tag 和所有分支，清理已删引用；索引状态分支独立', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cnb-mirror-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target.git');
  const run = async (args, cwd) => (await exec('git', args, { cwd, env: { ...process.env,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } })).stdout.trim();
  const git = async (args, cwd) => args[0] === 'lfs' ? '' : run(args, cwd);
  await fs.mkdir(source);
  await run(['init', '--initial-branch', 'main'], source);
  await fs.writeFile(path.join(source, 'plugins.json'), '[]\n');
  await run(['add', '.'], source);
  await run(['commit', '-m', 'initial'], source);
  await run(['branch', 'develop'], source);
  await run(['tag', '-a', 'v1.0.0', '-m', 'release'], source);
  await run(['init', '--bare', '--initial-branch', 'main', target]);
  await run(['config', 'receive.advertisePushOptions', 'true'], target);
  const first = await mirrorRepository(git, source, target, path.join(root, 'first.git'));
  assert.equal(first.commit, await run(['rev-parse', 'main'], target));
  assert.equal(await run(['rev-parse', 'v1.0.0'], source), await run(['rev-parse', 'v1.0.0'], target));
  assert.equal(await run(['rev-parse', 'develop'], source), await run(['rev-parse', 'develop'], target));
  await run(['branch', '-D', 'develop'], source);
  await run(['tag', '-d', 'v1.0.0'], source);
  await mirrorRepository(git, source, target, path.join(root, 'second.git'));
  await assert.rejects(run(['show-ref', '--verify', 'refs/heads/develop'], target));
  await assert.rejects(run(['show-ref', '--verify', 'refs/tags/v1.0.0'], target));
  const report = { registry: { mirrorUrl: target }, plugins: [{ status: 'failed' }] };
  await publishReport(git, root, report);
  assert.deepEqual(JSON.parse(await run(['show', `${STATUS_BRANCH}:cnb_mirrors.json`], target)), report);
  await run(['branch', 'feature'], source);
  await mirrorRepository(git, source, target, path.join(root, 'registry.git'), { registry: true });
  assert.deepEqual(JSON.parse(await run(['show', `${STATUS_BRANCH}:cnb_mirrors.json`], target)), report);
  await assert.rejects(run(['show-ref', '--verify', 'refs/heads/feature'], target));
});
