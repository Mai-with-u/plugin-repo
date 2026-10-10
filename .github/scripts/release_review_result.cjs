const assert = require('node:assert/strict');
const fs = require('node:fs');
const { parseReleaseIssue } = require('./release_review.cjs');

function validateReleaseReview(result, batch) {
  assert.equal(result?.schema_version, 1, '审核结果协议无效');
  assert.equal(result.plugin_id, batch.id, '审核插件不一致');
  assert.equal(result.repository_url, batch.repositoryUrl, '审核仓库不一致');
  assert.ok(Array.isArray(result.releases) && result.releases.length === batch.releases.length, '审核必须覆盖整个批次');
  const seen = new Set();
  for (const item of result.releases) {
    assert.ok(batch.releases.some(target => target.version === item.version && target.tag === item.tag && target.commit === item.commit), '审核版本或 commit 不一致');
    assert.ok(!seen.has(item.version), '审核版本重复');
    seen.add(item.version);
    assert.ok(['pass', 'manual_review'].includes(item.decision), '审核结论无效');
    assert.equal(typeof item.reviewed, 'boolean', '缺少源码检查状态');
    assert.ok(typeof item.summary === 'string' && item.summary.trim() && item.summary.length <= 2000, '缺少审核说明');
    assert.ok(Array.isArray(item.risks) && item.risks.length <= 20 && item.risks.every(risk =>
      typeof risk === 'string' && risk.trim() && risk.length <= 2000), '风险列表无效');
  }
  return result;
}

function passedReleases(result) {
  return result.releases.filter(item => item.decision === 'pass' && item.reviewed && item.risks.length === 0)
    .map(({ version, tag, commit }) => ({ version, tag, commit }));
}

function renderReleaseReview(result) {
  const passed = new Set(passedReleases(result).map(item => item.version));
  return result.releases.map(item => `### ${item.version}：${passed.has(item.version) ? '通过，等待自动收录' : '需人工处理'}\n\n` +
    `Commit：\`${item.commit}\`\n\n${item.summary}\n` +
    item.risks.map(risk => `- ${risk}`).join('\n')).join('\n\n') +
    `\n\n<details><summary>结构化审核结果</summary>\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n</details>`;
}

if (require.main === module) {
  const batch = parseReleaseIssue({ body: `<!-- plugin-release: ${fs.readFileSync('mai-release-targets.json', 'utf8')} -->` });
  const result = validateReleaseReview(JSON.parse(fs.readFileSync('codex-review.md', 'utf8')), batch);
  fs.writeFileSync('release-review.json', JSON.stringify(result, null, 2));
  fs.writeFileSync('codex-review.md', renderReleaseReview(result));
}
module.exports = { validateReleaseReview, passedReleases, renderReleaseReview };
