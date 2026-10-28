const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseReleaseIssue, approveRelease, blockedReleaseVersions, isBlockedRelease } = require('./release_review.cjs');

async function approveReleaseCommand(options) {
  assert.match(options.command.trim(), /^\/(?:approve|ap)$/, '请使用 /ap 或 /approve，不再接受版本参数');
  const release = parseReleaseIssue(options.issue);
  await approveRelease(options);
  return { version: release.version };
}

function rejectReleaseCommand({ root, issue, botLogin }) {
  assert.equal(issue.user.login, botLogin, '只能拒绝市场自动创建的发布审核 Issue');
  assert.equal(issue.state, 'open', 'Issue 已关闭');
  const release = parseReleaseIssue(issue);
  const index = JSON.parse(fs.readFileSync(path.join(root, 'plugin_versions.json'), 'utf8'));
  const normalize = url => url.replace(/\/$/, '').replace(/\.git$/, '').toLowerCase();
  const plugin = index.plugins.find(item => item.id === release.id && normalize(item.repositoryUrl) === normalize(release.repositoryUrl));
  assert.ok(!plugin?.versions.some(item => item.version === release.version && !item.yanked), '版本已收录，不能通过审核拒绝下架');
  const blocked = blockedReleaseVersions(root);
  if (!isBlockedRelease(blocked, release, release.version)) {
    blocked.push({ id: release.id, repositoryUrl: release.repositoryUrl, version: release.version });
    fs.writeFileSync(path.join(root, 'blocked_release_versions.json'), `${JSON.stringify(blocked, null, 2)}\n`);
  }
  return { version: release.version };
}

module.exports = { approveReleaseCommand, rejectReleaseCommand };
