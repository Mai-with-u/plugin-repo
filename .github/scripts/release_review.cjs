const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LABEL = 'plugin-release';
const MARKER = /<!-- plugin-release: (.+) -->/;

function parseReleaseIssue(issue) {
  const match = (issue.body || '').match(MARKER);
  assert.ok(match, '缺少发布审核信息');
  const data = JSON.parse(match[1]);
  assert.ok(typeof data.id === 'string' && /^[\w.-]+$/.test(data.id), '插件 ID 无效');
  assert.match(data.repositoryUrl, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
  const releases = data.releases || [{ version: data.version, tag: data.tag, commit: data.commit }];
  assert.ok(Array.isArray(releases) && releases.length > 0 && releases.length <= 5, '每批审核 1 至 5 个发布版本');
  assert.ok(Array.isArray(data.discarded || []), '跳过版本必须是数组');
  for (const release of [...releases, ...(data.discarded || [])]) {
    assert.match(release.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
    assert.ok(release.tag === release.version || release.tag === `v${release.version}`, 'Tag 无效');
    assert.match(release.commit, /^[0-9a-f]{40}$/);
  }
  assert.equal(new Set(releases.map(item => item.version)).size, releases.length, '批次版本重复');
  if (data.base_commit) assert.match(data.base_commit, /^[0-9a-f]{40}$/);
  return { id: data.id, repositoryUrl: data.repositoryUrl, releases, discarded: data.discarded || [], base_commit: data.base_commit || null };
}

function releaseKey(data) {
  return JSON.stringify([data.id, data.repositoryUrl, data.version, data.tag, data.commit]);
}

async function createReleaseGate({ root, request, repository = process.env.GITHUB_REPOSITORY,
  botLogin = process.env.MAI_REVIEW_BOT_LOGIN }) {
  assert.ok(repository && botLogin, '同步需要 GITHUB_REPOSITORY 和 MAI_REVIEW_BOT_LOGIN');
  const trusted = JSON.parse(fs.readFileSync(path.join(root, 'trusted_developers.json'), 'utf8'));
  assert.ok(Array.isArray(trusted), '授信名单必须是数组');
  for (const entry of trusted) {
    assert.ok(Number.isSafeInteger(entry.owner_id) && entry.owner_id > 0, '授信 owner_id 无效');
    assert.ok(Array.isArray(entry.repositories) && entry.repositories.every(repo => /^[\w.-]+\/[\w.-]+$/.test(repo)), '授信 repositories 无效');
  }
  const base = `/repos/${repository}`;
  const issues = new Map();
  for (let page = 1; ; page++) {
    const batch = await request(`${base}/issues?state=all&labels=${LABEL}&per_page=100&page=${page}`);
    for (const issue of batch) {
      if (issue.pull_request || issue.user?.login !== botLogin) continue;
      try {
        const data = parseReleaseIssue(issue);
        for (const release of [...data.releases, ...data.discarded]) {
          issues.set(releaseKey({ ...data, ...release }), issue);
        }
      } catch { /* 非发布审核 Issue */ }
    }
    if (batch.length < 100) break;
  }
  const owners = new Map();
  const pending = new Map();
  async function ensureReviewLabel(issue) {
    if (issue.state === 'open' && !issue.labels.some(label => label.name === 'validated')) {
      await request(`${base}/issues/${issue.number}/labels`, {
        method: 'POST', body: JSON.stringify({ labels: ['validated'] }),
      });
      issue.labels.push({ name: 'validated' });
    }
  }
  const admit = async (plugin, candidate) => {
    const slug = plugin.repositoryUrl.slice('https://github.com/'.length).replace(/\/$/, '').replace(/\.git$/, '');
    if (!owners.has(slug)) owners.set(slug, await request(`/repos/${slug}`));
    const info = owners.get(slug);
    if (trusted.some(entry => entry.owner_id === info.owner.id &&
      entry.repositories.some(repo => repo.toLowerCase() === info.full_name.toLowerCase()))) return true;
    const data = { id: plugin.id, repositoryUrl: `https://github.com/${slug}`,
      version: candidate.version, tag: candidate.tag, commit: candidate.commit };
    const key = releaseKey(data);
    const issue = issues.get(key);
    if (issue) await ensureReviewLabel(issue);
    else {
      if (!pending.has(plugin.id)) pending.set(plugin.id, new Map());
      pending.get(plugin.id).set(key, { ...data, published_at: candidate.published_at });
    }
    return false;
  };
  admit.flush = async (plugin, previous) => {
    const candidates = [...(pending.get(plugin.id)?.values() || [])].sort((a, b) =>
      (b.published_at || '').localeCompare(a.published_at || '') ||
      require('./sync_plugin_versions.cjs').compareVersions(b.version, a.version));
    if (!candidates.length) return;
    const snapshot = item => ({ version: item.version, tag: item.tag, commit: item.commit });
    const data = { id: plugin.id, repositoryUrl: candidates[0].repositoryUrl,
      releases: candidates.slice(0, 5).map(snapshot), discarded: candidates.slice(5).map(snapshot),
      base_commit: previous?.versions.find(item => !item.yanked)?.commit || null };
    const rows = data.releases.map(item =>
      `| [${item.tag}](${data.repositoryUrl}/releases/tag/${item.tag}) | \`${item.commit}\` |`).join('\n');
    const issue = await request(`${base}/issues`, {
      method: 'POST', body: JSON.stringify({
        title: `[Release] ${plugin.id} ${data.releases.map(item => item.version).join(', ')}`,
        body: `<!-- plugin-release: ${JSON.stringify(data)} -->\n\n插件发布批次等待自动审核。\n\n` +
          `- 插件：\`${plugin.id}\`\n- 仓库：${data.repositoryUrl}\n\n` +
          `| 发布版本 | Commit |\n| --- | --- |\n${rows}\n\n` +
          (data.discarded.length ? `本次跳过较早的 ${data.discarded.length} 个 Release，不收录、不补开审核。\n\n` : '') +
          `无风险且完整审核的版本自动收录；有风险或结论不确定的版本留给维护者。维护者核实后可发送独立的 \`/approve\` 或 \`/ap\` 批准剩余版本，或使用 \`/reject 原因\` 拒绝。`,
        labels: [LABEL],
      }),
    });
    for (const release of [...data.releases, ...data.discarded]) {
      issues.set(releaseKey({ ...data, ...release }), issue);
    }
    pending.delete(plugin.id);
    await ensureReviewLabel(issue);
  };
  return admit;
}

async function approveRelease({ root, issue, request, botLogin, approvedReleases }) {
  assert.equal(issue.user.login, botLogin, '只能批准市场自动创建的发布审核 Issue');
  assert.equal(issue.state, 'open', 'Issue 已关闭');
  const data = parseReleaseIssue(issue);
  const targets = approvedReleases || data.releases;
  assert.ok(targets.length > 0 && targets.every(target => data.releases.some(item =>
    item.version === target.version && item.tag === target.tag && item.commit === target.commit)), '批准目标不属于当前审核批次');
  const plugins = JSON.parse(fs.readFileSync(path.join(root, 'plugins.json'), 'utf8'));
  const plugin = plugins.find(item => item.id === data.id);
  assert.ok(plugin && plugin.repositoryUrl.replace(/\/$/, '').replace(/\.git$/, '') === data.repositoryUrl, '插件登记信息已改变');
  const output = path.join(root, 'plugin_versions.json');
  const index = JSON.parse(fs.readFileSync(output, 'utf8'));
  const position = index.plugins.findIndex(item => item.id === plugin.id);
  const previous = index.plugins[position];
  const { syncPlugin, skipConflictingPlugins } = require('./sync_plugin_versions.cjs');
  const detailsPath = path.join(root, 'plugin_details.json');
  const details = fs.existsSync(detailsPath) ? JSON.parse(fs.readFileSync(detailsPath, 'utf8')) : [];
  const expectedId = previous?.manifest_id || details.find(item => item.id === plugin.id)?.manifest?.id;
  const updated = await syncPlugin(plugin, previous, request, expectedId, async (_, candidate) =>
    targets.some(item => item.version === candidate.version && item.tag === candidate.tag && item.commit === candidate.commit));
  assert.ok(targets.every(release => updated.versions.some(item => item.version === release.version && item.tag === release.tag &&
    item.commit === release.commit && !item.yanked)), 'Release 已变更、撤回或校验失败，请重新审核');
  if (position < 0) index.plugins.push(updated);
  else index.plugins[position] = updated;
  assert.equal(skipConflictingPlugins(index.plugins).length, index.plugins.length, '插件身份冲突');
  fs.writeFileSync(output, `${JSON.stringify(index, null, 2)}\n`);
}

module.exports = { createReleaseGate, approveRelease, parseReleaseIssue };
