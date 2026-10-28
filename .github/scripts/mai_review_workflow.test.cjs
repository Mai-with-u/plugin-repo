const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const workflow = fs.readFileSync(path.join(__dirname, "../workflows/mai-review-run.yml"), "utf8").replace(/\r\n/g, "\n");

test('登记与 Release 请求只路由到对应审核入口', () => {
  const sources = ['mai-review.yml', 'mai-release-review.yml'].map(file =>
    fs.readFileSync(path.join(__dirname, '../workflows', file), 'utf8').replace(/\r\n/g, '\n'));
  const routes = sources.map(source => {
    const condition = source.split('    if: >-\n')[1].split('    uses:')[0]
      .replaceAll('github.event.issue.labels.*.name', 'github.event.issue.labels.map(label => label.name)');
    return new Function('github', 'contains', `return (${condition});`);
  });
  function route(labels, eventName = 'issues', comment = '/mai_review', label = 'validated') {
    const github = { event_name: eventName, actor: 'maisakagithub[bot]',
      event: { issue: { labels: labels.map(name => ({ name })) }, comment: { body: comment }, label: { name: label } } };
    return routes.map(fn => fn(github, (value, target) => value.includes(target)));
  }
  for (const label of ['plugin-submission', 'plugin-modification']) {
    assert.deepEqual(route([label, 'validated']), [true, false]);
    assert.deepEqual(route([label, 'validated'], 'issue_comment'), [true, false]);
    assert.deepEqual(route([label, 'validated'], 'issue_comment', '/mr'), [true, false]);
  }
  for (const labels of [ ['plugin-removal', 'validated'],
    ['plugin-removal', 'plugin-submission', 'validated'],
    ['plugin-removal', 'plugin-modification', 'validated'] ]) {
    assert.deepEqual(route(labels), [false, false]);
    assert.deepEqual(route(labels, 'issue_comment'), [false, false]);
    assert.deepEqual(route(labels, 'issue_comment', '/mr'), [false, false]);
  }
  assert.deepEqual(route(['plugin-release', 'validated']), [false, true]);
  assert.deepEqual(route(['plugin-release', 'plugin-submission', 'validated']), [false, true]);
  assert.deepEqual(route(['plugin-release', 'validated'], 'issue_comment'), [false, true]);
  assert.deepEqual(route(['plugin-release', 'validated'], 'issue_comment', '/mr'), [false, true]);
  assert.deepEqual(route(['plugin-release', 'validated'], 'issue_comment', '/mr extra'), [false, false]);
  assert.deepEqual(route(['plugin-release', 'validated'], 'issue_comment', '/mai_review_release'), [false, false]);
  assert.deepEqual(route(['plugin-submission', 'validated'], 'issue_comment', '/mai_review_release'), [false, false]);
  assert.deepEqual(route(['plugin-release', 'validated'], 'issue_comment', '已开始审核'), [false, false]);
  assert.deepEqual(route(['plugin-release'], 'issues', '', 'plugin-release'), [false, false]);
  assert.deepEqual(route(['plugin-submission'], 'issue_comment'), [false, false]);
});

function scriptFor(name) {
  const step = workflow.split(`      - name: ${name}\n`)[1]?.split("\n      - name:")[0];
  assert.ok(step, `Missing step: ${name}`);
  const script = step.split("          script: |\n")[1];
  assert.ok(script, `Missing script: ${name}`);
  return script.trimEnd().split("\n").map((line) => line.slice(12)).join("\n");
}

test('统一重审命令在两类 Issue 中均限维护者', async () => {
  const fn = new AsyncFunction('github', 'context', 'core', scriptFor('Check reviewer permission'));
  for (const [labels, permission, command, failed] of [
    [['plugin-release'], 'write', '/mai_review', false],
    [['plugin-release'], 'read', '/mai_review', true],
    [['plugin-submission'], 'write', '/mai_review', false],
    [['plugin-submission'], 'read', '/mai_review', true],
    [['plugin-release'], 'write', '/mr', false],
    [['plugin-release'], 'read', '/mr', true],
    [['plugin-submission'], 'write', '/mr', false],
    [['plugin-submission'], 'read', '/mr', true],
    [['plugin-release'], 'write', '/mr extra', true],
    [['plugin-release'], 'write', '/mai_review_release', true],
  ]) {
    const failures = [];
    const outputs = {};
    const github = { rest: {
      repos: { getCollaboratorPermissionLevel: async () => ({ data: { permission } }) },
      issues: { createComment: async () => {} },
    } };
    const context = { repo: {}, payload: { comment: { user: { login: 'user' }, body: command },
      issue: { labels: labels.map(name => ({ name })) } } };
    const core = { setFailed: value => failures.push(value), setOutput: (key, value) => { outputs[key] = value; } };
    await fn(github, context, core);
    assert.equal(failures.length > 0, failed);
    assert.equal(outputs.commenter, failed ? undefined : 'user');
  }
});

async function runScript(name, comments = [], extra = {}) {
  const posted = [];
  const outputs = {};
  const createComment = async (comment) => { posted.push(comment); return { data: { id: 99 } }; };
  const github = {
    paginate: async () => comments,
    rest: { issues: { listComments() {}, createComment } },
  };
  const context = { repo: { owner: "example", repo: "plugins" }, issue: { number: 7 }, runId: 123 };
  const core = { setOutput: (key, value) => { outputs[key] = value; }, setFailed: assert.fail };
  const localRequire = (name) => name === "fs"
    ? { readFileSync: () => "审核文本" }
    : require(path.resolve(__dirname, "../..", name));
  const process = { env: { REVIEW_ISSUE_NUMBER: "7", GITHUB_RUN_ATTEMPT: "1", GITHUB_SERVER_URL: "https://github.com", ...extra } };
  // Substitute trusted step outputs as GitHub Actions does before execution.
  const script = scriptFor(name)
    .replaceAll("${{ steps.review-start.outputs.review_run }}", "123:1")
    .replaceAll("${{ steps.review-start.outputs.review_count }}", "8")
    .replaceAll("${{ steps.build-context.outputs.latest_commit }}", "abc1234");
  await new AsyncFunction("github", "context", "core", "require", "process", script)(github, context, core, localRequire, process);
  return { posted, outputs };
}

test("all inline workflow JavaScript parses", () => {
  const scripts = [...workflow.matchAll(/          script: \|\n((?:            .*\n|\n)+)/g)];
  assert.equal(scripts.length, 6);
  for (const match of scripts) {
    const script = match[1].split("\n").map((line) => line.slice(12)).join("\n")
      .replace(/\$\{\{[^}]+\}\}/g, "trusted-output");
    assert.doesNotThrow(() => new AsyncFunction(script));
  }
});

test("every review comment uses the Mai App identity, including failure paths", () => {
  for (const name of ["Check reviewer permission", "Reserve review and announce start", "Post review comment", "Post review failure"]) {
    const step = workflow.split(`      - name: ${name}\n`)[1].split("\n      - name:")[0];
    assert.match(step, /github-token: \$\{\{ steps\.(?:result-app-token|app-token)\.outputs\.token/);
  }
  assert.ok(workflow.indexOf("id: app-token") < workflow.indexOf("id: review-start"));
  const refresh = workflow.split("      - name: Refresh Mai GitHub App token for result\n")[1].split("\n      - name:")[0];
  assert.match(refresh, /if: always\(\) && steps\.review-start\.outputs\.should_run == 'true'/);
  assert.match(refresh, /secrets\.MAI_REVIEW_APP_ID/);
  assert.match(refresh, /secrets\.MAI_REVIEW_APP_PRIVATE_KEY/);
});

test('审核诊断在成功、失败或取消后均保存，登记审核也适用', () => {
  const step = workflow.split('      - name: Save review diagnostics\n')[1]?.split('\n      - name:')[0];
  assert.ok(step);
  const condition = step.match(/        if: (.+)/)[1];
  assert.equal(condition, "always() && steps.review-start.outputs.should_run == 'true'");
  for (const file of ['codex-review-raw.md', 'step-review-events.jsonl', 'step-review-stderr.log', 'step-maimai-events.jsonl', 'step-maimai-stderr.log', 'mai-review-input.md', 'mai-release-target.json']) {
    assert.ok(step.includes(`            ${file}\n`), `Missing diagnostic: ${file}`);
  }
  assert.match(step, /if-no-files-found: ignore/);
  assert.match(workflow, /run_step_review\.cjs "\$REVIEW_PROMPT" codex-review\.md step-review/);
  assert.doesNotMatch(workflow, /ANTHROPIC_AUTH_TOKEN|claude --bare/);
});

test('CLI 下载覆盖 HTTP/2 断流并限制连接、传输和整体安装时间', () => {
  const install = workflow.split('      - name: Install Step Code CLI\n')[1].split('\n      - name:')[0];
  for (const option of ['--http1.1', '--connect-timeout 15', '--max-time 120', '--retry-all-errors', '--retry-max-time 480']) {
    assert.ok(install.includes(option), `Missing curl option: ${option}`);
  }
  assert.match(install, /timeout-minutes: 10/);
  assert.match(install, /sha256sum --check/);
  assert.match(workflow.split('      - name: Run StepFun review\n')[1].split('\n      - name:')[0], /timeout-minutes: 60/);
});

test('审核中标签按需创建，成功、失败或取消后均清理，404 可忽略', async () => {
  const calls = [];
  const github = { rest: { issues: {
    getLabel: async () => { throw { status: 404 }; },
    createLabel: async value => calls.push(['create', value.name]),
    addLabels: async value => calls.push(['add', value.labels]),
    removeLabel: async value => { calls.push(['remove', value.name]); throw { status: 404 }; },
  } } };
  const context = { repo: { owner: 'market', repo: 'plugins' } };
  const process = { env: { REVIEW_ISSUE_NUMBER: '7' } };
  for (const name of ['Mark review in progress', 'Clear review in progress']) {
    await new AsyncFunction('github', 'context', 'process', scriptFor(name))(github, context, process);
  }
  assert.deepEqual(calls, [['create', 'reviewing'], ['add', ['reviewing']], ['remove', 'reviewing']]);
  const cleanup = workflow.split('      - name: Clear review in progress\n')[1];
  assert.match(cleanup, /if: always\(\) && .*review-label.outcome == 'success'.*review-label.outcome == 'failure'/);
  assert.match(cleanup, /github-token: \$\{\{ steps.result-app-token.outputs.token/);
  github.rest.issues.removeLabel = async () => { throw { status: 403 }; };
  await assert.rejects(new AsyncFunction('github', 'context', 'process', scriptFor('Clear review in progress'))(github, context, process));
});

test("the eighth review reserves its count and announces immediately", async () => {
  const comments = Array.from({ length: 7 }, () => ({ user: { type: "Bot" }, body: "<!-- codex-mai-review -->" }));
  const { posted, outputs } = await runScript("Reserve review and announce start", comments);
  assert.equal(outputs.should_run, "true");
  assert.equal(outputs.review_count, 8);
  assert.equal(outputs.review_run, "123:1");
  assert.match(posted[0].body, /已开始审核/);
  assert.match(posted[0].body, /已审核：8次 \/ 8次$/);
});

test("the ninth request is rejected before invoking the model", async () => {
  const comments = Array.from({ length: 8 }, () => ({ user: { type: "Bot" }, body: "<!-- codex-mai-review -->" }));
  const { posted, outputs } = await runScript("Reserve review and announce start", comments);
  assert.equal(outputs.should_run, "false");
  assert.equal(outputs.review_run, undefined);
  assert.match(posted[0].body, /已达到审核次数上限/);
  assert.doesNotMatch(posted[0].body, /codex-mai-review-start/);
});

test("success and failure post separate results with the count", async () => {
  const success = await runScript("Post review comment");
  assert.match(success.posted[0].body, /审核文本/);
  assert.match(success.posted[0].body, /已审核：8次 \/ 8次$/);
  const failure = await runScript("Post review failure", [], { REVIEW_COUNT: "8", REVIEW_RUN: "123:1" });
  assert.match(failure.posted[0].body, /本次审核失败/);
  assert.match(failure.posted[0].body, /https:\/\/github.com\/example\/plugins\/actions\/runs\/123/);
  assert.match(failure.posted[0].body, /已审核：8次 \/ 8次$/);
});
