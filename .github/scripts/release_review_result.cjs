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
    assert.equal(typeof item.summary, 'string', `${item.version}: summary 必须是字符串，实际类型为 ${typeof item.summary}`);
    assert.ok(item.summary.trim(), `${item.version}: summary 不能为空`);
    assert.ok(Array.isArray(item.risks) && item.risks.every(risk =>
      typeof risk === 'string' && risk.trim()), '风险列表无效');
  }
  return result;
}

function parseReleaseReview(text, batch) {
  text = text.replace(/^\uFEFF/, '').trim();
  // 仅修复字符串外的尾逗号，不能改写风险说明中的文本。
  function decode(source) {
    let quoted = false;
    let escaped = false;
    let cleaned = '';
    for (let i = 0; i < source.length; i++) {
      const char = source[i];
      if (!quoted && char === ',' && /^\s*[}\]]/.test(source.slice(i + 1))) continue;
      cleaned += char;
      if (escaped) escaped = false;
      else if (quoted && char === '\\') escaped = true;
      else if (char === '"') quoted = !quoted;
    }
    return JSON.parse(cleaned);
  }
  let result;
  try { result = decode(text); } catch {
    const candidates = [];
    for (let start = 0; start < text.length; start++) {
      if (text[start] !== '{') continue;
      let depth = 0;
      let quoted = false;
      let escaped = false;
      for (let end = start; end < text.length; end++) {
        const char = text[end];
        if (escaped) { escaped = false; continue; }
        if (quoted && char === '\\') { escaped = true; continue; }
        if (char === '"') { quoted = !quoted; continue; }
        if (quoted) continue;
        if (char === '{') depth++;
        if (char === '}' && --depth === 0) {
          try {
            const value = decode(text.slice(start, end + 1));
            if (value?.schema_version === 1 && Array.isArray(value.releases)) candidates.push(value);
          } catch { /* 非 JSON 文本 */ }
          start = end;
          break;
        }
      }
    }
    assert.equal(candidates.length, 1, '必须包含唯一、完整的审核 JSON，截断或多份结论不能自动批准');
    result = candidates[0];
  }
  // 缺失证据字段的版本降为人工处理，不推断通过。
  if (Array.isArray(result?.releases)) {
    for (const item of result.releases) {
      const missing = [];
      if (typeof item.summary !== 'string' || !item.summary.trim()) {
        item.summary = '审核说明缺失，需人工核实。';
        missing.push('缺少审核说明');
      }
      if (typeof item.reviewed !== 'boolean') {
        item.reviewed = false;
        missing.push('缺少源码检查状态');
      }
      if (!Array.isArray(item.risks)) {
        missing.push('缺少有效风险列表');
        item.risks = typeof item.risks === 'string' && item.risks.trim() ? [item.risks] : [];
      }
      if (missing.length) {
        item.decision = 'manual_review';
        item.risks.push(...missing);
      }
    }
  }
  return validateReleaseReview(result, batch);
}

function passedReleases(result) {
  return result.releases.filter(item => item.decision === 'pass' && item.reviewed && item.risks.length === 0)
    .map(({ version, tag, commit }) => ({ version, tag, commit }));
}

function renderReleaseReview(result) {
  const passed = new Set(passedReleases(result).map(item => item.version));
  const excerpt = value => value.length > 2500 ? `${value.slice(0, 2500)}…（完整内容见审核产物）` : value;
  const summary = result.releases.map(item => `### ${item.version}：${passed.has(item.version) ? '通过，等待自动收录' : '需人工处理'}\n\n` +
    `Commit：\`${item.commit}\`\n\n${excerpt(item.summary)}\n` +
    excerpt(item.risks.map(risk => `- ${risk}`).join('\n'))).join('\n\n');
  const structured = JSON.stringify(result, null, 2);
  return summary + (structured.length <= 20000
    ? `\n\n<details><summary>结构化审核结果</summary>\n\n\`\`\`json\n${structured}\n\`\`\`\n</details>`
    : '\n\n完整结构化结果保存在本次运行的 release-review 审核产物中。');
}

if (require.main === module) {
  const batch = parseReleaseIssue({ body: `<!-- plugin-release: ${fs.readFileSync('mai-release-targets.json', 'utf8')} -->` });
  const result = parseReleaseReview(fs.readFileSync('codex-review.md', 'utf8'), batch);
  fs.writeFileSync('release-review.json', JSON.stringify(result, null, 2));
  fs.writeFileSync('codex-review.md', renderReleaseReview(result));
}
module.exports = { validateReleaseReview, parseReleaseReview, passedReleases, renderReleaseReview };
