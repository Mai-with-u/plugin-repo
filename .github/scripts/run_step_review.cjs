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
  // Allocate outside the agent: reference downloads never need a destructive reset.
  // Leave cleanup to the ephemeral Actions runner, not a model-generated command.
  const referenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-review-reference-'));
  const prompt = fs.readFileSync(promptFile, 'utf8') +
    `\n\n审核工作目录：${process.cwd()}。可按审核需要使用所有可用工具，包括联网核验 SDK 文档；不运行插件代码。` +
    `\n\n非交互审核的工具约束（适用于整个审核过程）：
- CI 无法提供交互确认；危险命令会直接终止审核，--approval-mode auto 也不能绕过保护。
- 优先使用 Read、Grep、Glob 等读取工具。必须使用 shell 时，每次只执行简单的字面命令；搜索表达式用单引号包裹，尤其不能把含反引号或美元符号的正则放入双引号。下载、搜索分开调用，不拼接复杂管道、循环、heredoc 或命令替换。
- 已为本次调用创建空的参考资料目录：${JSON.stringify(referenceDir)}。下载 SDK 或其他参考源码时，在该目录内使用新的子目录作为 git clone 目标；目标已存在则读取复用，或另取一个未使用的目录名。
- 不执行删除或清空目录的命令，包括 rm -rf、rm -r、递归删除 API；不为重新克隆、下载或重试而删除文件。无需清理临时资料，CI runner 负责回收。
- 只读检查插件、宿主和 SDK 源码；不执行 git reset --hard、git clean、强制覆盖或其他破坏性操作，不执行下载的代码，不尝试绕过工具安全保护。
- 工具遇到需要确认或拒绝执行时，若仍能继续，改用读取已有资料、新目录或只读 HTTP 获取。无法核实的事实标为证据不足，按原定输出格式完成审核，不将未完成的检查判为通过。` +
    (structured ? buildStructuredInstructions() : '');
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

function buildStructuredInstructions() {
  const batch = JSON.parse(fs.readFileSync('mai-release-targets.json', 'utf8'));
  const template = { schema_version: 1, plugin_id: batch.id, repository_url: batch.repositoryUrl,
    releases: batch.releases.map(({ version, tag, commit }) => ({ version, tag, commit,
      reviewed: false, decision: 'manual_review', summary: '填写实际检查证据', risks: ['填写风险或证据缺口'] })) };
  return '\n完成检查后直接输出唯一完整的审核 JSON 对象，不加 Markdown 或其他正文。' +
    '\n以下是本次真实审核对象的输出模板，身份字段保持不变，审核字段必须按实际证据填写；模板本身不是检查证据。' +
    '\nJSON 字符串中的双引号、反斜杠和换行必须正确转义。schema_version 使用数字 1。不要在 JSON 外附加评论。\n' +
    JSON.stringify(template, null, 2);
}

if (require.main === module) {
  const [promptFile, outputFile, prefix, mode] = process.argv.slice(2);
  runReview({ promptFile, outputFile, prefix, structured: mode === 'structured' }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
module.exports = { extractReview, runReview, buildStructuredInstructions };
