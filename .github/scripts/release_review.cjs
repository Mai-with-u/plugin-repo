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
  assert.match(data.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.ok(data.tag === data.version || data.tag === `v${data.version}`, 'Tag 无效');
  assert.match(data.commit, /^[0-9a-f]{40}$/);
  return data;
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
      try { issues.set(releaseKey(parseReleaseIssue(issue)), issue); } catch { /* 非发布审核 Issue */ }
    }
    if (batch.length < 100) break;
  }
  const owners = new Map();
  return async (plugin, candidate) => {
    const slug = plugin.repositoryUrl.slice('https://github.com/'.length).replace(/\/$/, '').replace(/\.git$/, '');
    if (!owners.has(slug)) owners.set(slug, await request(`/repos/${slug}`));
    const info = owners.get(slug);
    if (trusted.some(entry => entry.owner_id === info.owner.id &&
      entry.repositories.some(repo => repo.toLowerCase() === info.full_name.toLowerCase()))) return true;
    const data = { id: plugin.id, repositoryUrl: `https://github.com/${slug}`,
      version: candidate.version, tag: candidate.tag, commit: candidate.commit };
    const key = releaseKey(data);
    let issue = issues.get(key);
    if (!issue) {
      issue = await request(`${base}/issues`, {
        method: 'POST', body: JSON.stringify({
          title: `[Release] ${plugin.id} ${candidate.version}`,
          body: `<!-- plugin-release: ${JSON.stringify(data)} -->\n\n插件新版等待审核与维护者批准。\n\n` +
            `- 插件：\`${plugin.id}\`\n- 仓库：${data.repositoryUrl}\n` +
            `- 发布：[${candidate.tag}](${data.repositoryUrl}/releases/tag/${candidate.tag})\n` +
            `- Commit：\`${candidate.commit}\`\n\n维护者确认后发送独立的 \`/approve\` 评论；拒绝使用 \`/reject 原因\`。`,
          labels: [LABEL],
        }),
      });
      issues.set(key, issue);
    }
    // App 添加标签会触发麦麦审核；开单后中断也可在下次巡视恢复。
    if (issue.state === 'open' && !issue.labels.some(label => label.name === 'validated')) {
      await request(`${base}/issues/${issue.number}/labels`, {
        method: 'POST', body: JSON.stringify({ labels: ['validated'] }),
      });
      issue.labels.push({ name: 'validated' });
    }
    return false;
  };
}

async function approveRelease({ root, issue, request, botLogin }) {
  assert.equal(issue.user.login, botLogin, '只能批准市场自动创建的发布审核 Issue');
  assert.equal(issue.state, 'open', 'Issue 已关闭');
  const data = parseReleaseIssue(issue);
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
    candidate.version === data.version && candidate.tag === data.tag && candidate.commit === data.commit);
  assert.ok(updated.versions.some(item => item.version === data.version && item.tag === data.tag &&
    item.commit === data.commit && !item.yanked), 'Release 已变更、撤回或校验失败，请重新审核');
  if (position < 0) index.plugins.push(updated);
  else index.plugins[position] = updated;
  assert.equal(skipConflictingPlugins(index.plugins).length, index.plugins.length, '插件身份冲突');
  fs.writeFileSync(output, `${JSON.stringify(index, null, 2)}\n`);
}

module.exports = { createReleaseGate, approveRelease, parseReleaseIssue };
