const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const workflow = fs.readFileSync(path.join(__dirname, "../workflows/mai-review.yml"), "utf8").replace(/\r\n/g, "\n");

function scriptFor(name) {
  const step = workflow.split(`      - name: ${name}\n`)[1]?.split("\n      - name:")[0];
  assert.ok(step, `Missing step: ${name}`);
  const script = step.split("          script: |\n")[1];
  assert.ok(script, `Missing script: ${name}`);
  return script.trimEnd().split("\n").map((line) => line.slice(12)).join("\n");
}

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
  const process = { env: { GITHUB_RUN_ATTEMPT: "1", GITHUB_SERVER_URL: "https://github.com", ...extra } };
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
  assert.equal(scripts.length, 4);
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
