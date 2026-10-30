const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { extractReview, runStepWithRetries, runReview, REVIEW_LIMITS, COMMENT_LIMITS } = require('./run_step_review.cjs');

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

test('结构化提示模板从当前版本读取精确身份且默认不批准', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'review-prompt-test-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const batch = { id: 'author.actual-plugin', repositoryUrl: 'https://github.com/author/actual-plugin',
    version: '2.3.4', tag: 'v2.3.4', commit: 'a'.repeat(40) };
  fs.writeFileSync(path.join(cwd, 'mai-release-target.json'), JSON.stringify(batch));
  const modulePath = path.join(__dirname, 'run_step_review.cjs');
  const prompt = execFileSync(process.execPath, ['-e',
    `process.stdout.write(require(${JSON.stringify(modulePath)}).buildStructuredInstructions())`], { cwd, encoding: 'utf8' });
  const template = JSON.parse(prompt.slice(prompt.indexOf('{')));
  assert.equal(template.plugin_id, batch.id);
  assert.equal(template.repository_url, batch.repositoryUrl);
  assert.deepEqual(template, { schema_version: 2, plugin_id: batch.id, repository_url: batch.repositoryUrl, version: batch.version, tag: batch.tag, commit: batch.commit, reviewed: false,
    decision: 'manual_review', summary: '填写检查范围与结论', risks: [] });
});

function retryHarness(t, attempts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'step-retry-test-'));
  const dirs = [];
  const delays = [];
  let calls = 0;
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });
  const prefix = path.join(root, 'step-review');
  const options = { prefix, args: [], random: () => 0,
    wait: async ms => { delays.push(ms); },
    run: async ({ eventsFile, stderrFile, agentDir }) => {
      dirs.push(agentDir);
      const attempt = attempts[calls++] || attempts.at(-1);
      fs.writeFileSync(eventsFile, attempt.raw ?? (attempt.events || []).map(JSON.stringify).join('\n'));
      fs.writeFileSync(stderrFile, attempt.stderr || '');
      return attempt.code ?? (attempt.code === null ? null : 1);
    } };
  return { options, prefix, delays, dirs, calls: () => calls };
}

const rateError = '429: {"message":"concurrency reached, current: 9, limit: 8","type":"rate_limited"}';
const limited = { code: 1, events: [message('', 'error', { errorMessage: rateError })] };

test('真实并发限流错误退避重试，保留每次日志且不拼接旧结论', async t => {
  const h = retryHarness(t, [limited, limited, { code: 0, events: [message('完整结论')] }]);
  assert.equal(await runStepWithRetries(h.options), '完整结论');
  assert.deepEqual(h.delays, [30000, 60000]);
  assert.equal(new Set(h.dirs).size, 3);
  assert.match(fs.readFileSync(`${h.prefix}-attempt-1-events.jsonl`, 'utf8'), /concurrency reached/);
  assert.match(fs.readFileSync(`${h.prefix}-events.jsonl`, 'utf8'), /完整结论/);
});

test('持续限流最多四次，退出码为零的 API 错误也不能当成功', async t => {
  const h = retryHarness(t, [{ ...limited, code: 0 }]);
  await assert.rejects(runStepWithRetries(h.options), /尝试 4 次/);
  assert.equal(h.calls(), 4);
  assert.deepEqual(h.delays, [30000, 60000, 120000]);
});

test('无模型启动错误只重试一次，全新初始化仍失败则停止', async t => {
  const startup = { stderr: 'Error: No models available. Check your installation or add models to models.json.\n' };
  const h = retryHarness(t, [startup]);
  await assert.rejects(runStepWithRetries(h.options), /尝试 2 次/);
  assert.equal(h.calls(), 2);
  assert.deepEqual(h.delays, [5000]);
});

test('危险命令、授权错误、输出截断、无效事件和进程信号不重试', async t => {
  for (const attempt of [
    { ...limited, stderr: 'Blocked run_command: explicit approval is required' },
    { ...limited, events: [...limited.events, { type: 'tool_execution_end', result: { terminate: true } }] },
    { code: 1, events: [message('', 'error', { errorMessage: 'HTTP 403' })] },
    { code: 0, events: [message('旧结论'), message('', 'length')] },
    { code: 0, raw: '{' },
    { ...limited, code: null },
  ]) {
    const h = retryHarness(t, [attempt]);
    await assert.rejects(runStepWithRetries(h.options));
    assert.equal(h.calls(), 1);
    assert.deepEqual(h.delays, []);
  }
});

test('限流重试共用检查时间、总时间和剩余轮数', async t => {
  const h = retryHarness(t, [{ ...limited, events: [{ type: 'turn_start' }, ...limited.events] },
    { code: 0, events: [message('最终结论')] }]);
  const budgets = [];
  let time = 1000;
  const run = h.options.run;
  h.options.run = async options => { budgets.push(options); return run(options); };
  h.options.now = () => time;
  h.options.wait = async ms => { time += ms; };
  h.options.limits = { maxTurns: 2, inspectionMs: 60000, conclusionMs: 10000 };
  assert.equal(await runStepWithRetries(h.options), '最终结论');
  assert.deepEqual(budgets.map(b => [b.inspectionDeadline, b.maxTurns, b.timeoutMs]),
    [[61000, 2, 70000], [61000, 1, 40000]]);
});

test('退避等待耗尽总预算后不再启动下一次审核', async t => {
  const h = retryHarness(t, [limited]);
  let time = 0;
  h.options.now = () => time;
  h.options.wait = async ms => { assert.equal(ms, 15000); time += ms; };
  h.options.limits = { maxTurns: 2, inspectionMs: 10000, conclusionMs: 5000 };
  await assert.rejects(runStepWithRetries(h.options), { code: 'REVIEW_BUDGET_EXCEEDED' });
  assert.equal(h.calls(), 1);
});

test('结论超时及进程达到硬超时都返回预算错误，不采用中途结论', async t => {
  for (const hardTimeout of [true, false]) {
    const h = retryHarness(t, [{ code: hardTimeout ? null : 0,
      stderr: hardTimeout ? '' : 'MAI_REVIEW_CONCLUSION_TIMEOUT', events: [message('中途结论')] }]);
    let time = 0;
    const run = h.options.run;
    h.options.run = async options => { const result = await run(options); time = 15000; return result; };
    h.options.now = () => time;
    h.options.limits = { maxTurns: 2, inspectionMs: 10000, conclusionMs: 5000 };
    await assert.rejects(runStepWithRetries(h.options), { code: 'REVIEW_BUDGET_EXCEEDED' });
    assert.equal(h.calls(), 1);
    assert.equal(fs.existsSync(`${h.prefix}-attempt-1-events.jsonl`), true);
  }
});

test('正式审核和短评使用只读工具与 medium，按任务类型选择预算', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-mode-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldKey = process.env.STEP_API_KEY;
  process.env.STEP_API_KEY = 'test';
  t.after(() => { if (oldKey === undefined) delete process.env.STEP_API_KEY; else process.env.STEP_API_KEY = oldKey; });
  const promptFile = path.join(root, 'prompt.md');
  const outputFile = path.join(root, 'review.md');
  fs.writeFileSync(promptFile, '静态审核');
  for (const comment of [false, true]) {
    await runReview({ promptFile, outputFile, prefix: path.join(root, 'step'), comment,
      run: async ({ args, limits }) => {
        assert.equal(args[args.indexOf('--thinking') + 1], 'medium');
        assert.equal(args[args.indexOf('--tools') + 1], 'read,grep,find,ls,search_web');
        assert.match(args[args.indexOf('--extension') + 1], /review_budget\.mjs$/);
        assert.equal(limits, comment ? COMMENT_LIMITS : REVIEW_LIMITS);
        return '审核结论';
      } });
    assert.equal(fs.readFileSync(outputFile, 'utf8'), '审核结论\n');
  }
  await runReview({ promptFile, outputFile, prefix: path.join(root, 'step'),
    run: async () => { throw Object.assign(new Error('预算耗尽'), { code: 'REVIEW_BUDGET_EXCEEDED' }); } });
  assert.match(fs.readFileSync(outputFile, 'utf8'), /未能形成最终结论，请维护者确认/);
});

test('Release 预算耗尽仍输出当前版本的人工审核结果', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'review-budget-test-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const target = { id: 'author.plugin', repositoryUrl: 'https://github.com/author/plugin',
    version: '1.2.3', tag: 'v1.2.3', commit: 'a'.repeat(40) };
  fs.writeFileSync(path.join(cwd, 'mai-release-target.json'), JSON.stringify(target));
  fs.writeFileSync(path.join(cwd, 'prompt.md'), '审核 Release');
  const script = `const {runReview,REVIEW_LIMITS}=require(${JSON.stringify(path.join(__dirname, 'run_step_review.cjs'))});
    runReview({promptFile:'prompt.md',outputFile:'result.json',prefix:'step',structured:true,
      run:async({args,limits})=>{
        require('node:assert/strict').equal(args[args.indexOf('--thinking')+1],'medium');
        require('node:assert/strict').equal(limits,REVIEW_LIMITS);
        throw Object.assign(new Error('预算耗尽'),{code:'REVIEW_BUDGET_EXCEEDED'});
      }}).catch(e=>{console.error(e);process.exitCode=1});`;
  execFileSync(process.execPath, ['-e', script], { cwd, env: { ...process.env, STEP_API_KEY: 'test' }, stdio: 'pipe' });
  const result = JSON.parse(fs.readFileSync(path.join(cwd, 'result.json'), 'utf8'));
  assert.equal(result.schema_version, 2);
  assert.equal(result.plugin_id, target.id);
  assert.equal(result.commit, target.commit);
  assert.equal(result.version, target.version);
  assert.equal(result.reviewed, false);
  assert.equal(result.decision, 'manual_review');
  assert.equal(result.risks.length, 1);
});
