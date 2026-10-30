const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const REVIEW_LIMITS = { maxTurns: 32, inspectionMs: 25 * 60000, conclusionMs: 5 * 60000 };
const COMMENT_LIMITS = { maxTurns: 4, inspectionMs: 2 * 60000, conclusionMs: 60000 };
const READ_ONLY_TOOLS = 'read,grep,find,ls,search_web';

function budgetExceeded() {
  return Object.assign(new Error('审核预算已用完，未取得最终结论'), { code: 'REVIEW_BUDGET_EXCEEDED' });
}

function extractReview(events) {
  const messages = events.filter(event => event.type === 'message_end' && event.message?.role === 'assistant')
    .map(event => event.message);
  const last = messages.at(-1);
  if (!last || last.stopReason !== 'stop') {
    throw new Error(last?.errorMessage || `Step Code 未正常完成审核：${last?.stopReason || '无最终消息'}`);
  }
  const text = last.content.filter(item => item.type === 'text').map(item => item.text).join('\n').trim();
  if (!text) throw new Error('Step Code 审核结果为空');
  return text;
}

async function runReview({ promptFile, outputFile, prefix, structured = false, comment = false, run = runStepWithRetries }) {
  if (!process.env.STEP_API_KEY) throw new Error('缺少 STEP_API_KEY');
  const limits = comment ? COMMENT_LIMITS : REVIEW_LIMITS;
  const prompt = fs.readFileSync(promptFile, 'utf8') +
    `\n\n工作目录：${process.cwd()}。` +
    `\n检查预算为 ${limits.maxTurns} 轮、${limits.inspectionMs / 60000} 分钟，先到即结束检查，预留 ${limits.conclusionMs / 60000} 分钟输出结论。` +
    (structured ? buildStructuredInstructions() : '');
  const args = ['--print', '--mode', 'json', '--model', process.env.STEP_MODEL || 'step-5-preview',
    '--thinking', 'medium',
    '--no-session', '--no-extensions', '--no-skills', '--approval-mode', 'auto',
    '--tools', READ_ONLY_TOOLS, '--extension', path.join(__dirname, 'review_budget.mjs'), prompt];
  let text;
  try {
    text = await run({ args, prefix, limits });
  } catch (error) {
    if (error.code !== 'REVIEW_BUDGET_EXCEEDED' || comment) throw error;
    console.warn(error.message);
    text = renderBudgetExceeded(structured);
  }
  fs.writeFileSync(outputFile, `${text}\n`);
}

function renderBudgetExceeded(structured) {
  const summary = '本次静态审核已达到预算，未能形成最终结论，请维护者确认。已执行的检查保存在本次审核诊断产物中。';
  if (!structured) return summary;
  const target = JSON.parse(fs.readFileSync('mai-release-target.json', 'utf8'));
  return JSON.stringify({ schema_version: 2, plugin_id: target.id, repository_url: target.repositoryUrl,
    version: target.version, tag: target.tag, commit: target.commit, reviewed: false,
    decision: 'manual_review', summary, risks: ['审核预算耗尽，核心源码检查是否完成及最终结论需人工确认。'] });
}

async function spawnStep({ args, eventsFile, stderrFile, agentDir, inspectionDeadline, maxTurns, conclusionMs, timeoutMs }) {
  const stdout = fs.openSync(eventsFile, 'w');
  const stderr = fs.openSync(stderrFile, 'w');
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.env.STEP_BINARY || 'step', args, {
        env: { ...process.env, STEP_CODING_AGENT_DIR: agentDir,
          MAI_REVIEW_INSPECT_UNTIL: String(inspectionDeadline), MAI_REVIEW_MAX_TURNS: String(maxTurns),
          MAI_REVIEW_CONCLUSION_MS: String(conclusionMs) },
        stdio: ['ignore', stdout, stderr],
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
      });
      child.once('error', reject);
      child.once('close', resolve);
    });
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
}

async function runStepWithRetries({ args, prefix, run = spawnStep,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), random = Math.random,
  limits = REVIEW_LIMITS, now = Date.now }) {
  const eventsFile = `${prefix}-events.jsonl`;
  const stderrFile = `${prefix}-stderr.log`;
  const inspectionDeadline = now() + limits.inspectionMs;
  const deadline = inspectionDeadline + limits.conclusionMs;
  let remainingTurns = limits.maxTurns;
  // Four attempts in this one reserved review; never retry safety denials or signals.
  for (let attempt = 1; attempt <= 4; attempt++) {
    const timeoutMs = deadline - now();
    if (timeoutMs <= 0) throw budgetExceeded();
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-step-agent-'));
    const code = await run({ args, eventsFile, stderrFile, agentDir, inspectionDeadline,
      maxTurns: remainingTurns, conclusionMs: limits.conclusionMs, timeoutMs });
    const raw = fs.readFileSync(eventsFile, 'utf8');
    const stderr = fs.readFileSync(stderrFile, 'utf8');
    fs.copyFileSync(eventsFile, `${prefix}-attempt-${attempt}-events.jsonl`);
    fs.copyFileSync(stderrFile, `${prefix}-attempt-${attempt}-stderr.log`);
    const events = [];
    let parseError;
    for (const line of raw.split(/\r?\n/).filter(line => line.trim())) {
      try { events.push(JSON.parse(line)); } catch (error) { parseError = error; }
    }
    remainingTurns = Math.max(0, remainingTurns - events.filter(event => event.type === 'turn_start').length);
    if ((code === null && now() >= deadline) || stderr.includes('MAI_REVIEW_CONCLUSION_TIMEOUT')) throw budgetExceeded();
    let failure;
    try {
      if (code !== 0) throw new Error(`Step Code 退出码 ${code}`);
      if (parseError) throw parseError;
      return extractReview(events);
    } catch (error) { failure = error; }
    const messages = events.filter(event => event.type === 'message_end' && event.message?.role === 'assistant');
    const lastError = messages.at(-1)?.message?.errorMessage || '';
    const diagnostics = `${stderr}\n${lastError}`;
    const blocked = events.some(event => event.result?.terminate || event.details?.terminate) ||
      /Blocked run_command|requires confirmation|explicit approval|no interactive approval/i.test(stderr);
    const limited = /\b429\b/.test(diagnostics) && /concurrency reached|rate_limited|rate.limit|too many requests/i.test(diagnostics);
    // A failed model discovery may be transient. Try a clean agent directory once;
    // persistent installation/configuration errors still fail visibly.
    const bootstrap = messages.length === 0 && /No models available\./.test(stderr);
    const retry = code !== null && !blocked && attempt < 4 && (limited || (bootstrap && attempt === 1));
    if (!retry) throw new Error(`${failure.message}；尝试 ${attempt} 次，详见 ${eventsFile} 和 ${stderrFile}`);
    const delay = (limited ? 30000 * 2 ** (attempt - 1) : 5000) + Math.floor(random() * 10000);
    console.warn(`Step Code ${limited ? '触发服务限流' : '模型列表初始化失败'}，${Math.ceil(delay / 1000)} 秒后重试（${attempt}/4）`);
    await wait(Math.min(delay, Math.max(0, deadline - now())));
  }
}

function buildStructuredInstructions() {
  const target = JSON.parse(fs.readFileSync('mai-release-target.json', 'utf8'));
  const template = { schema_version: 2, plugin_id: target.id, repository_url: target.repositoryUrl,
    version: target.version, tag: target.tag, commit: target.commit,
      reviewed: false, decision: 'manual_review', summary: '填写检查范围与结论', risks: [] };
  return '\n输出 JSON 字段模板，身份字段保持原值，审核字段按本次结论填写：\n' +
    JSON.stringify(template, null, 2);
}

if (require.main === module) {
  const [promptFile, outputFile, prefix, mode] = process.argv.slice(2);
  runReview({ promptFile, outputFile, prefix, structured: mode === 'structured', comment: mode === 'comment' }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
module.exports = { extractReview, runReview, buildStructuredInstructions, runStepWithRetries,
  renderBudgetExceeded, spawnStep, REVIEW_LIMITS, COMMENT_LIMITS, READ_ONLY_TOOLS };
