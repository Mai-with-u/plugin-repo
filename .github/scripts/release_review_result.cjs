const assert = require('node:assert/strict');
const fs = require('node:fs');
const { parseReleaseIssue } = require('./release_review.cjs');

function validateReleaseReview(result, target) {
  assert.equal(result?.schema_version, 2, '审核结果协议无效');
  assert.equal(result.plugin_id, target.id, '审核插件不一致');
  assert.equal(result.repository_url, target.repositoryUrl, '审核仓库不一致');
  assert.ok(!Object.hasOwn(result, 'releases'), '不再接受批次审核结果');
  for (const key of ['version', 'tag', 'commit']) assert.equal(result[key], target[key], '审核版本或 commit 不一致');
  assert.ok(['pass', 'manual_review'].includes(result.decision), '审核结论无效');
  assert.equal(typeof result.reviewed, 'boolean', '缺少源码检查状态');
  assert.equal(typeof result.summary, 'string', 'summary 必须是字符串');
  assert.ok(result.summary.trim(), 'summary 不能为空');
  assert.ok(Array.isArray(result.risks) && result.risks.every(risk => typeof risk === 'string' && risk.trim()), '风险列表无效');
  return result;
}

function parseReleaseReview(text, target) {
  text = text.replace(/^\uFEFF/, '').trim();
  // 仅修复字符串外的尾逗号，不能改写风险说明中的文本。
  function decode(source) {
    let quoted = false;
    let escaped = false;
    let cleaned = '';
    const closers = [];
    let repairedClosers = 0;
    for (let i = 0; i < source.length; i++) {
      let char = source[i];
      if (!quoted && char === ',' && /^\s*[}\]]/.test(source.slice(i + 1))) continue;
      if (!quoted) {
        if (char === '{') closers.push('}');
        else if (char === '[') closers.push(']');
        else if (char === '}' || char === ']') {
          const expected = closers.pop();
          assert.ok(expected, '审核 JSON 存在多余闭合括号');
          if (char !== expected) {
            // 仅替换一个类型写错的闭合括号；不补全截断，不修改字符串或审核字段。
            assert.ok(++repairedClosers <= 1, '审核 JSON 存在多处括号错误');
            char = expected;
          }
        }
      }
      cleaned += char;
      if (escaped) escaped = false;
      else if (quoted && char === '\\') escaped = true;
      else if (char === '"') quoted = !quoted;
    }
    assert.equal(closers.length, 0, '审核 JSON 未完整闭合');
    const value = JSON.parse(cleaned);
    // 仅兼容协议 2 的字符串写法，不推断缺失或未知的协议版本。
    if (typeof value?.schema_version === 'string' && /^2(?:\.0+)?$/.test(value.schema_version.trim())) {
      value.schema_version = 2;
    }
    return value;
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
        // 同时计算数组与对象，才能提取闭合括号类型写错但结构完整的候选。
        if (char === '{' || char === '[') depth++;
        if ((char === '}' || char === ']') && --depth === 0) {
          try {
            const value = decode(text.slice(start, end + 1));
            // 先收集完整结论，再统一校验，避免忽略另一份协议错误的结论。
            if (value && typeof value === 'object' && ('plugin_id' in value || 'schema_version' in value)) candidates.push(value);
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
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const item = result;
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
  return validateReleaseReview(result, target);
}

function isReleasePassed(result) {
  return result.decision === 'pass' && result.reviewed && result.risks.length === 0;
}

// A malformed model response is evidence of an incomplete review, never approval.
// Keep strict parsing for consumers; only the workflow converts it to manual work.
function finalizeReleaseReview(text, target) {
  try {
    return { result: parseReleaseReview(text, target), error: null };
  } catch (error) {
    const reason = `自动审核结果未通过校验，需人工核实：${error.message}`;
    const result = { schema_version: 2, plugin_id: target.id, repository_url: target.repositoryUrl,
      version: target.version, tag: target.tag, commit: target.commit,
        reviewed: false, decision: 'manual_review',
        summary: '模型输出无法作为有效审核结论。原始输出保存在本次运行诊断产物 codex-review-raw.md 中；请核实后重新审核或人工处理。',
        risks: [reason] };
    return { result: validateReleaseReview(result, target), error: reason };
  }
}

function renderReleaseReview(result) {
  const excerpt = value => value.length > 2500 ? `${value.slice(0, 2500)}…（完整内容见审核产物）` : value;
  const summary = `### ${result.version}：${isReleasePassed(result) ? '通过，等待自动收录' : '需人工处理'}\n\n` +
    `Commit：\`${result.commit}\`\n\n${excerpt(result.summary)}\n` +
    excerpt(result.risks.map(risk => `- ${risk}`).join('\n'));
  const structured = JSON.stringify(result, null, 2);
  return summary + (structured.length <= 20000
    ? `\n\n<details><summary>结构化审核结果</summary>\n\n\`\`\`json\n${structured}\n\`\`\`\n</details>`
    : '\n\n完整结构化结果保存在本次运行的 release-review 审核产物中。');
}

if (require.main === module) {
  const target = parseReleaseIssue({ body: `<!-- plugin-release: ${fs.readFileSync('mai-release-target.json', 'utf8')} -->` });
  const raw = fs.readFileSync('codex-review.md', 'utf8');
  fs.writeFileSync('codex-review-raw.md', raw);
  const { result, error } = finalizeReleaseReview(raw, target);
  if (error) console.warn(error);
  fs.writeFileSync('release-review.json', JSON.stringify(result, null, 2));
  fs.writeFileSync('codex-review.md', renderReleaseReview(result));
}
module.exports = { validateReleaseReview, parseReleaseReview, finalizeReleaseReview, isReleasePassed, renderReleaseReview };
