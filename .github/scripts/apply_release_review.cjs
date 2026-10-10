const assert = require('node:assert/strict');
const { parseReleaseIssue, approveRelease } = require('./release_review.cjs');
const { validateReleaseReview, passedReleases } = require('./release_review_result.cjs');

async function applyReleaseReview({ root, issue, result, targets, request, botLogin }) {
  assert.equal(issue.user.login, botLogin, '审核 Issue 作者不可信');
  assert.equal(issue.state, 'open', '审核 Issue 已关闭');
  assert.ok(issue.labels.some(label => label.name === 'plugin-release'), '不是发布审核 Issue');
  assert.ok(!issue.labels.some(label => label.name === 'rejected'), '批次已被拒绝');
  const batch = parseReleaseIssue(issue);
  assert.deepEqual(batch, parseReleaseIssue({ body: `<!-- plugin-release: ${JSON.stringify(targets)} -->` }), '审核期间批次发生变化');
  validateReleaseReview(result, batch);
  const passed = passedReleases(result);
  if (passed.length) await approveRelease({ root, issue, request, botLogin, approvedReleases: passed });
  return { passed, manual: result.releases.filter(item => !passed.some(target => target.version === item.version)).map(item => item.version) };
}

module.exports = { applyReleaseReview };
