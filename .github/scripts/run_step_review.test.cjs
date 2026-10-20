const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { extractReview } = require('./run_step_review.cjs');

function message(text, stopReason = 'stop', extra = {}) {
  return { type: 'message_end', message: { role: 'assistant', stopReason,
    content: [{ type: 'text', text }], ...extra } };
}

test('只提取正常结束的最终助手回复，不把工具调用和中途说明当结果', () => {
  const events = [message('先查看源码', 'toolUse'),
    { type: 'tool_execution_end', result: { text: '插件文件内容' } },
    message('{"schema_version":1}')];
  assert.equal(extractReview(events), '{"schema_version":1}');
});

test('API 错误、输出截断或仍在调用工具时不得使用早先回复', () => {
  for (const reason of ['error', 'length', 'toolUse', 'aborted']) {
    assert.throws(() => extractReview([message('中间说明'), message('', reason)]));
  }
  assert.throws(() => extractReview([message('', 'error', { errorMessage: 'HTTP 403' })]), /HTTP 403/);
});

test('没有最终回复或回复为空时报错，思考内容不进入审核正文', () => {
  assert.throws(() => extractReview([]), /无最终消息/);
  assert.throws(() => extractReview([message('  ')]), /为空/);
  const event = message('审核结论');
  event.message.content.unshift({ type: 'thinking', thinking: '内部思考' });
  assert.equal(extractReview([event]), '审核结论');
});

test('结构化提示模板从当前批次读取精确身份且默认不批准', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'review-prompt-test-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const batch = { id: 'author.actual-plugin', repositoryUrl: 'https://github.com/author/actual-plugin',
    releases: [{ version: '2.3.4', tag: 'release-2.3.4', commit: 'a'.repeat(40) }] };
  fs.writeFileSync(path.join(cwd, 'mai-release-targets.json'), JSON.stringify(batch));
  const modulePath = path.join(__dirname, 'run_step_review.cjs');
  const prompt = execFileSync(process.execPath, ['-e',
    `process.stdout.write(require(${JSON.stringify(modulePath)}).buildStructuredInstructions())`], { cwd, encoding: 'utf8' });
  const template = JSON.parse(prompt.slice(prompt.indexOf('{')));
  assert.equal(template.plugin_id, batch.id);
  assert.equal(template.repository_url, batch.repositoryUrl);
  assert.deepEqual(template.releases[0], { ...batch.releases[0], reviewed: false,
    decision: 'manual_review', summary: '填写实际检查证据', risks: ['填写风险或证据缺口'] });
});
