const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseReleaseIssue, approveRelease, blockedReleaseVersions, isBlockedRelease } = require('./release_review.cjs');

function pendingReleases(root, batch) {
  const index = JSON.parse(fs.readFileSync(path.join(root, 'plugin_versions.json'), 'utf8'));
  const normalize = url => url.replace(/\/$/, '').replace(/\.git$/, '').toLowerCase();
  const plugin = index.plugins.find(item => item.id === batch.id && normalize(item.repositoryUrl) === normalize(batch.repositoryUrl));
  const blocked = blockedReleaseVersions(root);
  return batch.releases.filter(release => !isBlockedRelease(blocked, batch, release.version) && !plugin?.versions.some(item =>
    item.version === release.version && item.tag === release.tag && item.commit === release.commit && !item.yanked));
}

function approvalTargets(command, batch, pending) {
  const match = command.trim().match(/^\/(?:approve|ap)(?:\s+([\s\S]+))?$/);
  assert.ok(match, '请使用 /ap 或 /ap 1.0.1 1.0.2');
  if (!match[1]) return pending;
  const versions = match[1].trim().split(/[\s,，]+/);
  assert.ok(versions.every(version => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)), '批准参数必须是三段式版本号');
  assert.equal(new Set(versions).size, versions.length, '批准版本重复');
  assert.ok(versions.every(version => batch.releases.some(item => item.version === version)), '批准版本不属于当前 Issue');
  return batch.releases.filter(item => versions.includes(item.version));
}

async function approveReleaseCommand(options) {
  const batch = parseReleaseIssue(options.issue);
  const targets = approvalTargets(options.command, batch, pendingReleases(options.root, batch));
  assert.ok(targets.length, '没有待批准版本');
  await approveRelease({ ...options, approvedReleases: targets });
  return { approved: targets.map(item => item.version), pending: pendingReleases(options.root, batch).map(item => item.version) };
}

function rejectReleaseCommand({ root, issue, botLogin }) {
  assert.equal(issue.user.login, botLogin, '只能拒绝市场自动创建的发布审核 Issue');
  assert.equal(issue.state, 'open', 'Issue 已关闭');
  const batch = parseReleaseIssue(issue);
  const pending = pendingReleases(root, batch);
  const blocked = blockedReleaseVersions(root);
  for (const item of pending) {
    if (!isBlockedRelease(blocked, batch, item.version)) blocked.push({ id: batch.id, repositoryUrl: batch.repositoryUrl, version: item.version });
  }
  fs.writeFileSync(path.join(root, 'blocked_release_versions.json'), `${JSON.stringify(blocked, null, 2)}\n`);
  return { rejected: pending.map(item => item.version), approved: batch.releases.filter(item =>
    !pending.includes(item) && !isBlockedRelease(blocked, batch, item.version)).map(item => item.version) };
}

module.exports = { pendingReleases, approvalTargets, approveReleaseCommand, rejectReleaseCommand };
