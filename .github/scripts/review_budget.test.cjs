const assert = require('node:assert/strict');
const test = require('node:test');
let reviewBudget;
test.before(async () => { ({ default: reviewBudget } = await import('./review_budget.mjs')); });

function harness() {
  const handlers = new Map();
  const tools = [];
  const timers = [];
  const cancelled = [];
  let time = 0;
  let aborted = false;
  reviewBudget({ on: (name, handler) => handlers.set(name, handler), setActiveTools: value => tools.push(value) }, {
    inspectionDeadline: 25000, maxTurns: 2, conclusionMs: 5000, now: () => time,
    schedule: (callback, ms) => { timers.push({ callback, ms }); return timers.length; },
    cancel: id => cancelled.push(id),
  });
  return { tools, timers, cancelled, setTime: value => { time = value; }, aborted: () => aborted,
    emit: (name, event = {}) => handlers.get(name)(event, { abort: () => { aborted = true; } }) };
}

test('轮数用完后停止工具、移除请求中的工具，并保留上下文输出结论', () => {
  const h = harness();
  const messages = [{ role: 'user', content: '审核当前插件' }];
  const payload = { messages, tools: [{ name: 'read' }], tool_choice: 'auto', parallel_tool_calls: true };
  for (let i = 0; i < 2; i++) {
    h.emit('turn_start');
    assert.equal(h.emit('tool_call'), undefined);
    assert.equal(h.emit('before_provider_request', { payload }), undefined);
  }
  h.emit('turn_start');
  assert.deepEqual(h.tools, [[]]);
  assert.equal(h.emit('tool_call').block, true);
  const result = h.emit('context', { messages });
  assert.equal(result.messages[0], messages[0]);
  assert.match(result.messages[1].content[0].text, /输出最终结论/);
  assert.equal(messages.length, 1);
  assert.deepEqual(h.emit('before_provider_request', { payload }), { messages });
  assert.equal(payload.tools.length, 1);
  assert.equal(h.timers.length, 1);
});

test('检查时间到达后进入结论阶段，结论超时中止', () => {
  const h = harness();
  h.emit('turn_start');
  h.setTime(25000);
  assert.equal(h.emit('tool_call').block, true);
  assert.equal(h.timers[0].ms, 5000);
  h.timers[0].callback();
  assert.equal(h.aborted(), true);
});

test('正常完成或会话关闭清除结论计时器', () => {
  for (const event of ['agent_settled', 'session_shutdown']) {
    const h = harness();
    h.setTime(25000);
    h.emit('context', { messages: [] });
    h.emit(event);
    assert.deepEqual(h.cancelled, [1]);
    assert.equal(h.aborted(), false);
  }
});
