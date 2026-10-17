const fs = require('node:fs');
const path = require('node:path');
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
  const prompt = fs.readFileSync(promptFile, 'utf8') +
    `\n\n审核工作目录：${process.cwd()}。可按审核需要使用所有可用工具，包括联网核验 SDK 文档；不运行插件代码。` +
    (structured ? '\n完成检查后直接输出唯一完整的审核 JSON 对象，不加 Markdown 或其他正文。' : '');
  const eventsFile = `${prefix}-events.jsonl`;
  const stderrFile = `${prefix}-stderr.log`;
  const stdout = fs.openSync(eventsFile, 'w');
  const stderr = fs.openSync(stderrFile, 'w');
  try {
    const args = ['--print', '--mode', 'json', '--model', process.env.STEP_MODEL || 'step-5-preview',
      '--thinking', structured ? 'high' : 'medium',
      '--no-session', '--no-extensions', '--no-skills', '--approval-mode', 'auto', prompt];
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.env.STEP_BINARY || 'step', args, {
        env: { ...process.env, STEP_CODING_AGENT_DIR: path.resolve('.step-review-agent') },
        stdio: ['ignore', stdout, stderr],
      });
      child.once('error', reject);
      child.once('exit', resolve);
    });
    if (code !== 0) throw new Error(`Step Code 退出码 ${code}，详见 ${eventsFile} 和 ${stderrFile}`);
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
  const events = fs.readFileSync(eventsFile, 'utf8').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  const text = extractReview(events);
  fs.writeFileSync(outputFile, `${text}\n`);
}

if (require.main === module) {
  const [promptFile, outputFile, prefix, mode] = process.argv.slice(2);
  runReview({ promptFile, outputFile, prefix, structured: mode === 'structured' }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
module.exports = { extractReview, runReview };
