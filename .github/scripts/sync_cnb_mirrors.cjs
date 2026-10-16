const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

const STATUS_BRANCH = 'cnb-mirror-status';
const DISABLED_BUILDS = {
  auto_trigger: false, cron_auto_trigger: false,
  auto_trigger_by_npc: false, forked_repo_auto_trigger: false,
};

function slug(value, label) {
  assert.ok(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)
    && !value.includes('..') && !value.endsWith('.git'), `${label} 必须是有效的 CNB 路径段`);
  return value.toLowerCase();
}

function configuration(env = process.env) {
  assert.ok(env.CNB_GROUP, '请配置 CNB_GROUP');
  const group = env.CNB_GROUP.split('/').map(s => slug(s, 'CNB_GROUP')).join('/');
  const registry = slug(env.CNB_REGISTRY_REPO || 'plugin-repo', 'CNB_REGISTRY_REPO');
  const concurrency = Number(env.CNB_SYNC_CONCURRENCY || 4);
  assert.ok(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 8,
    'CNB_SYNC_CONCURRENCY 必须为 1 到 8');
  const source = env.GITHUB_REPOSITORY || 'Mai-with-u/plugin-repo';
  assert.match(source, /^[\w.-]+\/[\w.-]+$/);
  return { group, registry, concurrency, source, token: env.CNB_TOKEN };
}

function mirrorPlan(plugins, config) {
  const destinations = new Map();
  // This historical first entry is a registry example, not a downloadable plugin.
  return plugins.filter(plugin => !(plugin.id === 'MaiM-with-u.example-plugin1'
    && plugin.repositoryUrl === 'https://github.com/MaiM-with-u/MaiBot')).map(plugin => {
    assert.ok(typeof plugin.id === 'string' && plugin.id, '插件 ID 不能为空');
    const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(plugin.repositoryUrl);
    assert.ok(match, `不支持的插件仓库：${plugin.repositoryUrl}`);
    const source = `${match[1]}/${match[2]}`.toLowerCase();
    const hash = createHash('sha256').update(source).digest('hex').slice(0, 12);
    const readable = source.replace('/', '--').replace(/[^a-z0-9-]/g, '-').slice(0, 46);
    const name = `p-${readable}-${hash}`;
    assert.notEqual(name, config.registry, '插件镜像与索引仓库冲突');
    const existing = destinations.get(name);
    assert.ok(!existing || existing === source, `镜像名称冲突：${source}`);
    destinations.set(name, source);
    return { id: plugin.id, repositoryUrl: plugin.repositoryUrl,
      sourceUrl: `https://github.com/${source}.git`,
      mirrorPath: `${config.group}/${name}`, mirrorUrl: `https://cnb.cool/${config.group}/${name}` };
  });
}

function redact(value, token) {
  let text = String(value);
  if (token) {
    for (const secret of [token, Buffer.from(`cnb:${token}`).toString('base64')]) {
      text = text.split(secret).join('[REDACTED]');
    }
  }
  return text.slice(0, 3000);
}

function gitEnvironment(token) {
  // Scope credentials to CNB. Never store them in remotes, Git config files or argv.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' };
  delete env.CNB_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  // Prevent inherited tracing or config from exposing the authorization header.
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_TRACE') || key.startsWith('GIT_CONFIG_') || key === 'GIT_CURL_VERBOSE') delete env[key];
  }
  Object.assign(env, {
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'http.https://cnb.cool/.extraheader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`cnb:${token}`).toString('base64')}`,
    GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '',
  });
  return env;
}

function gitClient(token) {
  const env = gitEnvironment(token);
  return async (args, cwd) => {
    try {
      const result = await exec('git', args, { cwd, env, timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
      return result.stdout.trim();
    } catch (error) {
      throw new Error(redact(`git ${args[0]} 失败：${error.stderr || error.message}`, token));
    }
  };
}

function apiClient(token, fetcher = fetch) {
  return async (route, method = 'GET', body) => {
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetcher(`https://api.cnb.cool/${route}`, {
          method, redirect: 'error', signal: AbortSignal.timeout(60000),
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.cnb.api+json',
            'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        // Do not retry a create with an unknown outcome; a rerun checks existence first.
        if (method === 'POST' || attempt >= 2) throw new Error(redact(error.message, token));
      }
      if ((!response || response.status === 429 || response.status >= 500) && attempt < 2 && method !== 'POST') {
        await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }
      assert.ok(response, 'CNB API 无响应');
      if (!response.ok) {
        const error = new Error(`CNB API ${method} ${route}: HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    }
  };
}

async function ensureRepository(api, repo, sourceUrl) {
  try {
    await api(repo);
  } catch (error) {
    if (error.status !== 404) throw error;
    const split = repo.lastIndexOf('/');
    await api(`${repo.slice(0, split)}/-/repos`, 'POST', {
      name: repo.slice(split + 1), visibility: 'public', description: `MaiBot mirror of ${sourceUrl}`,
    });
  }
  // Must succeed before any third-party refs are uploaded, including on reruns.
  await api(`${repo}/-/settings/cloud-native-build`, 'PUT', DISABLED_BUILDS);
}

async function mirrorRepository(git, sourceUrl, mirrorUrl, directory, { registry = false, prepared = false } = {}) {
  // Bare cloning never checks out or executes plugin files, hooks or submodules.
  if (!prepared) await git(['clone', '--bare', '--', sourceUrl, directory]);
  await git(['remote', 'add', 'cnb', mirrorUrl], directory);
  const branch = await git(['symbolic-ref', '--short', 'HEAD'], directory);
  if (registry) assert.equal(branch, 'main', '索引源仓库默认分支必须为 main');
  await git(['lfs', 'fetch', '--all', 'origin'], directory);
  // A source .lfsconfig may point at GitHub or an external LFS service. Override
  // its push endpoint so reporting success always means objects reached CNB.
  const lfsTarget = `${mirrorUrl.replace(/\.git$/, '')}.git/info/lfs`;
  await git(['config', 'lfs.pushurl', lfsTarget], directory);
  await git(['config', 'remote.cnb.lfspushurl', lfsTarget], directory);
  await git(['lfs', 'push', '--all', 'cnb'], directory);
  // Push the default branch first so a new CNB repository can initialize its HEAD.
  await git(['push', '-o', 'ci.skip', 'cnb', `+refs/heads/${branch}:refs/heads/${branch}`], directory);
  const heads = registry ? '+refs/heads/main:refs/heads/main' : '+refs/heads/*:refs/heads/*';
  // Only heads/tags are managed. Never push GitHub's internal pull-request refs.
  await git(['push', '--prune', '-o', 'ci.skip', 'cnb', heads, '+refs/tags/*:refs/tags/*'], directory);
  return { default_branch: branch, commit: await git(['rev-parse', 'HEAD'], directory) };
}

async function syncPlugins(plan, concurrency, sync, now = () => new Date().toISOString()) {
  const results = new Array(plan.length);
  const pending = new Map();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, plan.length) }, async () => {
    while (next < plan.length) {
      const index = next++;
      const plugin = plan[index];
      if (!pending.has(plugin.mirrorPath)) {
        pending.set(plugin.mirrorPath, (async () => {
          try {
            const result = await sync(plugin);
            return { status: 'synced', synced_at: now(), ...result };
          }
          catch (error) { return { status: 'failed', error: error.message }; }
        })());
      }
      const { sourceUrl, ...entry } = plugin;
      results[index] = { ...entry, ...await pending.get(plugin.mirrorPath) };
    }
  }));
  return results;
}

async function publishReport(git, directory, report) {
  const worktree = path.join(directory, 'report');
  await fs.mkdir(worktree);
  await fs.writeFile(path.join(worktree, 'cnb_mirrors.json'), `${JSON.stringify(report, null, 2)}\n`);
  await git(['init', '--initial-branch', STATUS_BRANCH], worktree);
  await git(['add', 'cnb_mirrors.json'], worktree);
  await git(['-c', 'user.name=CNB Mirror Bot', '-c', 'user.email=cnb-mirror@users.noreply.github.com',
    'commit', '-m', 'chore: update CNB mirror status [skip ci]'], worktree);
  await git(['push', '--force', '-o', 'ci.skip', report.registry.mirrorUrl,
    `HEAD:refs/heads/${STATUS_BRANCH}`], worktree);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  assert.ok(process.argv.slice(2).every(arg => arg === '--dry-run'), '仅支持 --dry-run 参数');
  const config = configuration();
  const plugins = JSON.parse(await fs.readFile('plugins.json', 'utf8'));
  let plan = mirrorPlan(plugins, config);
  const registryUrl = `https://cnb.cool/${config.group}/${config.registry}`;
  if (dryRun) {
    console.log(JSON.stringify({ registry: registryUrl, plugins: plan }, null, 2));
    return;
  }
  assert.ok(config.token, '请配置 CNB_TOKEN Secret');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'maibot-cnb-'));
  const api = apiClient(config.token);
  const git = gitClient(config.token);
  const report = { schema_version: 1, generated_at: new Date().toISOString(),
    registry: { repositoryUrl: `https://github.com/${config.source}`, mirrorUrl: registryUrl }, plugins: [] };
  try {
    // Fail fast on organization/credential problems before processing hundreds of repos.
    await ensureRepository(api, `${config.group}/${config.registry}`, report.registry.repositoryUrl);
    // Pin the registry snapshot before the long plugin run. Its list and mirrored
    // index must describe the same revision even if main advances during this job.
    const registryDirectory = path.join(directory, 'registry.git');
    await git(['clone', '--bare', '--', `${report.registry.repositoryUrl}.git`, registryDirectory]);
    const snapshotPlugins = JSON.parse(await git(['show', 'refs/heads/main:plugins.json'], registryDirectory));
    plan = mirrorPlan(snapshotPlugins, config);
    report.registry.source_commit = await git(['rev-parse', 'refs/heads/main'], registryDirectory);
    report.plugins = await syncPlugins(plan, config.concurrency, async plugin => {
      console.log(`同步 ${plugin.repositoryUrl} -> ${plugin.mirrorUrl}`);
      await ensureRepository(api, plugin.mirrorPath, plugin.repositoryUrl);
      const destination = path.join(directory, plugin.mirrorPath.split('/').pop());
      try { return await mirrorRepository(git, plugin.sourceUrl, plugin.mirrorUrl, destination); }
      finally { await fs.rm(destination, { recursive: true, force: true }); }
    });
    try {
      const result = await mirrorRepository(git, `${report.registry.repositoryUrl}.git`, registryUrl,
        registryDirectory, { registry: true, prepared: true });
      Object.assign(report.registry, { status: 'synced', synced_at: new Date().toISOString(), ...result });
    } catch (error) {
      Object.assign(report.registry, { status: 'failed', error: redact(error.message, config.token) });
    }
    report.generated_at = new Date().toISOString();
    await fs.mkdir('cnb-sync-output', { recursive: true });
    await fs.writeFile('cnb-sync-output/cnb_mirrors.json', `${JSON.stringify(report, null, 2)}\n`);
    await publishReport(git, directory, report);
    const failed = report.plugins.filter(p => p.status === 'failed');
    const summary = `CNB 插件同步：${report.plugins.length - failed.length}/${report.plugins.length} 成功；索引：${report.registry.status}`;
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) {
      await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,
        `${summary}\n\n[CNB 索引](${registryUrl}) · [同步状态](${registryUrl}/-/blob/${STATUS_BRANCH}/cnb_mirrors.json)\n`);
    }
    if (failed.length || report.registry.status !== 'synced') process.exitCode = 1;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

module.exports = { configuration, mirrorPlan, redact, gitEnvironment, apiClient, ensureRepository,
  mirrorRepository, syncPlugins, publishReport, STATUS_BRANCH, DISABLED_BUILDS };
if (require.main === module) main().catch(error => {
  console.error(redact(error.message, process.env.CNB_TOKEN));
  process.exitCode = 1;
});
