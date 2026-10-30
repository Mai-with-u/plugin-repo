// Loaded explicitly by Step, even with automatic extension discovery disabled.
export default function reviewBudget(api, {
  inspectionDeadline = Number(process.env.MAI_REVIEW_INSPECT_UNTIL),
  maxTurns = Number(process.env.MAI_REVIEW_MAX_TURNS),
  conclusionMs = Number(process.env.MAI_REVIEW_CONCLUSION_MS),
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  if (!Number.isFinite(inspectionDeadline) || !Number.isInteger(maxTurns) || maxTurns < 0 ||
    !Number.isFinite(conclusionMs) || conclusionMs <= 0) {
    throw new Error('审核预算配置无效');
  }
  let turns = 0;
  let finishing = false;
  let timer;
  const conclusion = '检查预算已到，请根据已读取的源码按原定格式输出最终结论；尚未查清的核心部分列明并交维护者确认。';
  function checkBudget(ctx) {
    if (!finishing && (turns > maxTurns || now() >= inspectionDeadline)) {
      finishing = true;
      api.setActiveTools([]);
      console.error('审核检查预算已用完，进入结论阶段。');
      timer = schedule(() => {
        console.error('MAI_REVIEW_CONCLUSION_TIMEOUT');
        ctx.abort();
      }, conclusionMs);
    }
    return finishing;
  }
  api.on('turn_start', (_event, ctx) => { turns++; checkBudget(ctx); });
  api.on('tool_call', (_event, ctx) => {
    if (checkBudget(ctx)) return { block: true, reason: conclusion };
  });
  api.on('context', (event, ctx) => {
    if (checkBudget(ctx)) return { messages: [...event.messages,
      { role: 'user', content: [{ type: 'text', text: conclusion }], timestamp: now() }] };
  });
  api.on('before_provider_request', (event, ctx) => {
    if (checkBudget(ctx)) {
      const { tools, tool_choice, parallel_tool_calls, ...payload } = event.payload;
      return payload;
    }
  });
  api.on('agent_settled', () => cancel(timer));
  api.on('session_shutdown', () => cancel(timer));
}
