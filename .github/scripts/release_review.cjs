const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LABEL = 'plugin-release';
const MARKER = /<!-- plugin-release: (.+) -->/;
const SUPERSEDED = '<!-- plugin-release-superseded:';

function isSupersededRelease(issue) {
  return (issue.body || '').includes(SUPERSEDED);
}

function readReleaseIssue(issue) {
  const match = (issue.body || '').match(MARKER);
  assert.ok(match, '缺少发布审核信息');
  const data = JSON.parse(match[1]);
  assert.ok(typeof data.id === 'string' && /^[\w.-]+$/.test(data.id), '插件 ID 无效');
  assert.match(data.repositoryUrl, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
  assert.ok(Array.isArray(data.discarded || []), '跳过版本必须是数组');
  return data;
}

function releaseSnapshot(release) {
  assert.match(release.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.ok(release.tag === release.version || release.tag === `v${release.version}`, 'Tag 无效');
  assert.match(release.commit, /^[0-9a-f]{40}$/);
  return { version: release.version, tag: release.tag, commit: release.commit };
}

function parseReleaseIssue(issue) {
  const data = readReleaseIssue(issue);
  // 已打开的旧单版本 Issue 可继续处理；多版本旧单只供历史去重读取。
  if (data.releases !== undefined) {
    assert.ok(Array.isArray(data.releases) && data.releases.length === 1, '仅支持单个 Release 审核');
    assert.ok(data.version === undefined, '审核目标格式冲突');
  }
  const release = releaseSnapshot(data.releases ? data.releases[0] : data);
  if (data.base_commit) assert.match(data.base_commit, /^[0-9a-f]{40}$/);
  return { id: data.id, repositoryUrl: data.repositoryUrl, ...release,
    discarded: (data.discarded || []).map(releaseSnapshot), base_commit: data.base_commit || null };
}

function releaseKey(data) {
  return JSON.stringify([data.id, data.repositoryUrl, data.version, data.tag, data.commit]);
}

function blockedReleaseVersions(root) {
  const file = path.join(root, 'blocked_release_versions.json');
  if (!fs.existsSync(file)) return [];
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Array.isArray(entries), '拒绝版本配置必须是数组');
  for (const entry of entries) {
    parseReleaseIssue({ body: `<!-- plugin-release: ${JSON.stringify({ ...entry, tag: entry.version, commit: '0'.repeat(40) })} -->` });
  }
  return entries;
}

function isBlockedRelease(entries, plugin, version) {
  return entries.some(entry => entry.id === plugin.id &&
    entry.repositoryUrl.toLowerCase() === plugin.repositoryUrl.replace(/\/$/, '').replace(/\.git$/, '').toLowerCase() && entry.version === version);
}

async function createReleaseGate({ root, request, repository = process.env.GITHUB_REPOSITORY,
  botLogin = process.env.MAI_REVIEW_BOT_LOGIN }) {
  assert.ok(repository && botLogin, '同步需要 GITHUB_REPOSITORY 和 MAI_REVIEW_BOT_LOGIN');
  const trusted = JSON.parse(fs.readFileSync(path.join(root, 'trusted_developers.json'), 'utf8'));
  const blocked = blockedReleaseVersions(root);
  assert.ok(Array.isArray(trusted), '授信名单必须是数组');
  for (const entry of trusted) {
    assert.ok(Number.isSafeInteger(entry.owner_id) && entry.owner_id > 0, '授信 owner_id 无效');
    assert.ok(Array.isArray(entry.repositories) && entry.repositories.every(repo => /^[\w.-]+\/[\w.-]+$/.test(repo)), '授信 repositories 无效');
  }
  const base = `/repos/${repository}`;
  const issues = new Map();
  const pluginIssues = new Map();
  function rememberIssue(id, issue) {
    if (!pluginIssues.has(id)) pluginIssues.set(id, new Map());
    pluginIssues.get(id).set(issue.number, issue);
  }
  for (let page = 1; ; page++) {
    const batch = await request(`${base}/issues?state=all&labels=${LABEL}&per_page=100&page=${page}`);
    for (const issue of batch) {
      if (issue.pull_request || issue.user?.login !== botLogin) continue;
      try {
        const data = readReleaseIssue(issue);
        // 只读历史快照，避免旧批次及已跳过版本被重新开单；不参与审核和批准。
        const history = (data.releases || [data]).map(releaseSnapshot);
        const discarded = (data.discarded || []).map(releaseSnapshot);
        rememberIssue(data.id, issue);
        if (issue.labels.some(label => label.name === 'rejected')) {
          for (const release of history) blocked.push({ id: data.id, repositoryUrl: data.repositoryUrl, version: release.version });
        }
        for (const release of [...history, ...discarded]) {
          issues.set(releaseKey({ ...data, ...release }), issue);
        }
      } catch { /* 非发布审核 Issue */ }
    }
    if (batch.length < 100) break;
  }
  const owners = new Map();
  const pending = new Map();
  async function ensureReviewLabel(issue) {
    if (issue.state === 'open' && !isSupersededRelease(issue) && !issue.labels.some(label => label.name === 'rejected') && !issue.labels.some(label => label.name === 'validated')) {
      await request(`${base}/issues/${issue.number}/labels`, {
        method: 'POST', body: JSON.stringify({ labels: ['validated'] }),
      });
      issue.labels.push({ name: 'validated' });
    }
  }
  async function reconcileIssues(plugin) {
    // Issue 编号表示创建顺序；即使最新单已关闭，也不能恢复旧单审核。
    const history = [...(pluginIssues.get(plugin.id)?.values() || [])].sort((a, b) => b.number - a.number);
    const latest = history[0];
    if (!latest) return;
    for (const old of history.slice(1)) {
      if (old.state !== 'open') continue;
      const body = isSupersededRelease(old) ? old.body :
        `${old.body}\n\n${SUPERSEDED} ${latest.number} -->\n\n⏭️ 已由新发版审核单 #${latest.number} 取代，本单版本跳过审核，不再收录；这不代表风险拒绝。`;
      await request(`${base}/issues/${old.number}`, {
        method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'not_planned', body,
          labels: old.labels.map(label => label.name).filter(name => !['validated', 'needs-manual-review'].includes(name)) }),
      });
      old.state = 'closed';
      old.body = body;
    }
    // 清理完成后再触发新单；中途失败时，下次同步继续清理，不重复开单。
    await ensureReviewLabel(latest);
  }
  const admit = async (plugin, candidate) => {
    if (isBlockedRelease(blocked, plugin, candidate.version)) return false;
    const slug = plugin.repositoryUrl.slice('https://github.com/'.length).replace(/\/$/, '').replace(/\.git$/, '');
    if (!owners.has(slug)) owners.set(slug, await request(`/repos/${slug}`));
    const info = owners.get(slug);
    if (trusted.some(entry => entry.owner_id === info.owner.id &&
      entry.repositories.some(repo => repo.toLowerCase() === info.full_name.toLowerCase()))) return true;
    const data = { id: plugin.id, repositoryUrl: `https://github.com/${slug}`,
      version: candidate.version, tag: candidate.tag, commit: candidate.commit };
    const key = releaseKey(data);
    const issue = issues.get(key);
    if (!issue) {
      if (!pending.has(plugin.id)) pending.set(plugin.id, new Map());
      pending.get(plugin.id).set(key, { ...data, published_at: candidate.published_at });
    }
    return false;
  };
  admit.flush = async (plugin, previous) => {
    const candidates = [...(pending.get(plugin.id)?.values() || [])].sort((a, b) =>
      (b.published_at || '').localeCompare(a.published_at || '') ||
      require('./sync_plugin_versions.cjs').compareVersions(b.version, a.version));
    if (!candidates.length) return reconcileIssues(plugin);
    const snapshot = item => ({ version: item.version, tag: item.tag, commit: item.commit });
    const data = { id: plugin.id, repositoryUrl: candidates[0].repositoryUrl,
      ...snapshot(candidates[0]), discarded: candidates.slice(1).map(snapshot),
      base_commit: previous?.versions.find(item => !item.yanked)?.commit || null };
    const issue = await request(`${base}/issues`, {
      method: 'POST', body: JSON.stringify({
        title: `[Release] ${plugin.id} ${data.version}`,
        body: `<!-- plugin-release: ${JSON.stringify(data)} -->\n\n仅最新发布版本等待自动审核。\n\n` +
          `- 插件：\`${plugin.id}\`\n- 仓库：${data.repositoryUrl}\n\n` +
          `| 发布版本 | Commit |\n| --- | --- |\n| [${data.tag}](${data.repositoryUrl}/releases/tag/${data.tag}) | \`${data.commit}\` |\n\n` +
          (data.discarded.length ? `本次跳过较早的 ${data.discarded.length} 个 Release，不收录、不补开审核。\n\n` : '') +
          `无风险且完整审核的版本自动收录；未通过或依据不足时交给维护者。维护者核实后可发送独立的 \`/approve\` 或 \`/ap\` 批准，或使用 \`/reject 原因\` 拒绝。`,
        labels: [LABEL],
      }),
    });
    rememberIssue(plugin.id, issue);
    for (const release of [data, ...data.discarded]) {
      issues.set(releaseKey({ ...data, ...release }), issue);
    }
    pending.delete(plugin.id);
    await reconcileIssues(plugin);
  };
  return admit;
}

async function approveRelease({ root, issue, request, botLogin }) {
  assert.equal(issue.user.login, botLogin, '只能批准市场自动创建的发布审核 Issue');
  assert.equal(issue.state, 'open', 'Issue 已关闭');
  assert.ok(!isSupersededRelease(issue), '审核单已被新版取代');
  assert.ok(!issue.labels.some(label => label.name === 'rejected'), '版本已被拒绝');
  const data = parseReleaseIssue(issue);
  const blocked = blockedReleaseVersions(root);
  assert.ok(!isBlockedRelease(blocked, data, data.version), '版本已被永久拒绝');
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
    data.version === candidate.version && data.tag === candidate.tag && data.commit === candidate.commit);
  assert.ok(updated.versions.some(item => item.version === data.version && item.tag === data.tag &&
    item.commit === data.commit && !item.yanked), 'Release 已变更、撤回或校验失败，请重新审核');
  if (position < 0) index.plugins.push(updated);
  else index.plugins[position] = updated;
  assert.equal(skipConflictingPlugins(index.plugins).length, index.plugins.length, '插件身份冲突');
  fs.writeFileSync(output, `${JSON.stringify(index, null, 2)}\n`);
}

module.exports = { createReleaseGate, approveRelease, parseReleaseIssue, blockedReleaseVersions, isBlockedRelease, isSupersededRelease };
