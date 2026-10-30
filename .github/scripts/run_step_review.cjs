const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

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

async function runReview({ promptFile, outputFile, prefix, structured = false }) {
  if (!process.env.STEP_API_KEY) throw new Error('缺少 STEP_API_KEY');
  const referenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-review-reference-'));
  const prompt = fs.readFileSync(promptFile, 'utf8') +
    `\n\n工作目录：${process.cwd()}。采用静态源码审查，使用 Read、Grep、Glob 按需读取文件，可联网核实宿主与 SDK 文档。` +
    `\n使用 shell 时每次执行简单命令，搜索表达式使用单引号，下载与搜索分开调用。工具不可用时换用已有资料、分段读取或只读 HTTP 请求。` +
    `\n参考资料目录：${JSON.stringify(referenceDir)}。下载资料使用其中的新子目录，已有资料直接复用；临时文件由 runner 回收。` +
    (structured ? buildStructuredInstructions() : '');
  const args = ['--print', '--mode', 'json', '--model', process.env.STEP_MODEL || 'step-5-preview',
    '--thinking', structured ? 'high' : 'medium',
    '--no-session', '--no-extensions', '--no-skills', '--approval-mode', 'auto', prompt];
  const text = await runStepWithRetries({ args, prefix });
  fs.writeFileSync(outputFile, `${text}\n`);
}

async function spawnStep({ args, eventsFile, stderrFile, agentDir }) {
  const stdout = fs.openSync(eventsFile, 'w');
  const stderr = fs.openSync(stderrFile, 'w');
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.env.STEP_BINARY || 'step', args, {
        env: { ...process.env, STEP_CODING_AGENT_DIR: agentDir },
        stdio: ['ignore', stdout, stderr],
      });
      child.once('error', reject);
      child.once('exit', resolve);
    });
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
}

async function runStepWithRetries({ args, prefix, run = spawnStep,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), random = Math.random }) {
  const eventsFile = `${prefix}-events.jsonl`;
  const stderrFile = `${prefix}-stderr.log`;
  // Four attempts in this one reserved review; never retry safety denials or signals.
  for (let attempt = 1; attempt <= 4; attempt++) {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-step-agent-'));
    const code = await run({ args, eventsFile, stderrFile, agentDir });
    const raw = fs.readFileSync(eventsFile, 'utf8');
    const stderr = fs.readFileSync(stderrFile, 'utf8');
    fs.copyFileSync(eventsFile, `${prefix}-attempt-${attempt}-events.jsonl`);
    fs.copyFileSync(stderrFile, `${prefix}-attempt-${attempt}-stderr.log`);
    const events = [];
    let parseError;
    for (const line of raw.split(/\r?\n/).filter(line => line.trim())) {
      try { events.push(JSON.parse(line)); } catch (error) { parseError = error; }
    }
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
    await wait(delay);
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
  runReview({ promptFile, outputFile, prefix, structured: mode === 'structured' }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
module.exports = { extractReview, runReview, buildStructuredInstructions, runStepWithRetries };
