const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseReleaseIssue, approveRelease, blockedReleaseVersions, isBlockedRelease } = require('./release_review.cjs');
const { validateReleaseReview, passedReleases, rejectedReleases } = require('./release_review_result.cjs');

async function applyReleaseReview({ root, issue, result, targets, request, botLogin }) {
  assert.equal(issue.user.login, botLogin, '审核 Issue 作者不可信');
  assert.equal(issue.state, 'open', '审核 Issue 已关闭');
  assert.ok(issue.labels.some(label => label.name === 'plugin-release'), '不是发布审核 Issue');
  assert.ok(!issue.labels.some(label => label.name === 'rejected'), '批次已被拒绝');
  const batch = parseReleaseIssue(issue);
  assert.deepEqual(batch, parseReleaseIssue({ body: `<!-- plugin-release: ${JSON.stringify(targets)} -->` }), '审核期间批次发生变化');
  validateReleaseReview(result, batch);
  const passed = passedReleases(result);
  const rejected = rejectedReleases(result, batch);
  if (passed.length) await approveRelease({ root, issue, request, botLogin, approvedReleases: passed });
  if (rejected.length) {
    const blocked = blockedReleaseVersions(root);
    for (const version of rejected) {
      if (!isBlockedRelease(blocked, batch, version)) blocked.push({ id: batch.id, repositoryUrl: batch.repositoryUrl, version });
    }
    fs.writeFileSync(path.join(root, 'blocked_release_versions.json'), `${JSON.stringify(blocked, null, 2)}\n`);
  }
  return { passed, rejected, manual: result.releases.filter(item =>
    !passed.some(target => target.version === item.version) && !rejected.includes(item.version)).map(item => item.version) };
}

module.exports = { applyReleaseReview };
