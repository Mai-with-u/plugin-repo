const assert = require('node:assert/strict');
const { parseReleaseIssue, approveRelease } = require('./release_review.cjs');
const { validateReleaseReview, isReleasePassed } = require('./release_review_result.cjs');

async function applyReleaseReview({ root, issue, result, target, request, botLogin }) {
  assert.equal(issue.user.login, botLogin, '审核 Issue 作者不可信');
  assert.equal(issue.state, 'open', '审核 Issue 已关闭');
  assert.ok(issue.labels.some(label => label.name === 'plugin-release'), '不是发布审核 Issue');
  assert.ok(!issue.labels.some(label => label.name === 'rejected'), '版本已被拒绝');
  const release = parseReleaseIssue(issue);
  assert.deepEqual(release, parseReleaseIssue({ body: `<!-- plugin-release: ${JSON.stringify(target)} -->` }), '审核期间目标发生变化');
  validateReleaseReview(result, release);
  const approved = isReleasePassed(result);
  if (approved) await approveRelease({ root, issue, request, botLogin });
  return { version: release.version, approved };
}

module.exports = { applyReleaseReview };
