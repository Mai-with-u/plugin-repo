const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const workflow = fs.readFileSync(path.join(__dirname, "../workflows/validate-issue.yml"), "utf8").replace(/\r\n/g, "\n");

function scriptFor(name) {
  return workflow.split(`      - name: ${name}\n`)[1].split("\n      - name:")[0]
    .split("          script: |\n")[1].trimEnd().split("\n").map((line) => line.slice(12)).join("\n");
}

const manifest = {
  manifest_version: 2, id: "example.demo", name: "Demo", version: "1.0.0",
  description: "Example plugin", author: { name: "Example", url: "https://github.com/example" },
  license: "MIT", urls: { repository: "https://github.com/example/demo" },
  host_application: { min_version: "0.12.0", max_version: "0.15.99" },
  sdk: { min_version: "2.0.0", max_version: "2.99.99" },
  capabilities: [], i18n: { default_locale: "zh-CN" },
};
const release = { tag_name: "v1.0.0", draft: false, published_at: "2026-10-04T00:00:00Z", assets: [] };

async function validate(pages, { type = "add", apiError = false } = {}) {
  const outputs = {};
  const requests = [];
  const https = {
    get(url, callback) {
      const response = new EventEmitter();
      response.statusCode = 200;
      const request = new EventEmitter();
      request.setTimeout = () => {};
      callback(response);
      queueMicrotask(() => {
        response.emit("data", JSON.stringify(manifest));
        response.emit("end");
      });
      return request;
    },
  };
  const plugins = type === "add" ? [] : [{ id: "example.old", repositoryUrl: "https://github.com/example/old" }];
  const localRequire = (name) => name === "https" ? https : { readFileSync: () => JSON.stringify(plugins) };
  const core = { setOutput: (key, value) => { outputs[key] = value; } };
  const body = type === "add"
    ? "### 插件 ID / Plugin ID\n\nexample.demo\n\n### 仓库地址 / Repository URL\n\nhttps://github.com/example/demo"
    : type === "modify"
      ? "### 当前插件 ID / Current Plugin ID\n\nexample.old\n\n### 新插件 ID / New Plugin ID\n\nexample.demo\n\n### 新的仓库地址 / New Repository URL\n\nhttps://github.com/example/demo"
      : "### 插件 ID / Plugin ID\n\nexample.old";
  const context = { payload: { issue: { body, labels: [{ name: type === "add" ? "plugin-submission" : type === "modify" ? "plugin-modification" : "plugin-removal" }] } } };
  const github = { rest: { repos: { listReleases() {} } }, paginate: {
    async *iterator(endpoint, options) {
      requests.push(options);
      if (apiError) throw Object.assign(new Error("Unavailable"), { status: 503 });
      for (const data of pages) yield { data };
    },
  } };
  await new AsyncFunction("require", "core", "context", "github", "console", scriptFor("Parse and Validate Plugin"))(
    localRequire, core, context, github, { log() {} },
  );
  return { outputs, requests };
}

test("no releases or only drafts fail validation", async () => {
  for (const pages of [[[]], [[{ ...release, draft: true }]], [[{ ...release, published_at: null }]]]) {
    const { outputs } = await validate(pages);
    assert.equal(outputs.status, "error");
    assert.match(outputs.message, /插件尚未发布 Release/);
    assert.equal(outputs.manifest_host_min_version, "0.12.0");
  }
});

test("published and prerelease source packages pass and display MaiBot range", async () => {
  for (const published of [release, { ...release, prerelease: true }]) {
    const { outputs, requests } = await validate([[published]]);
    assert.equal(outputs.status, "success");
    assert.match(outputs.message, /适配 MaiBot 版本（manifest 声明）.*0\.12\.0 ～ 0\.15\.99/);
    assert.match(outputs.message, /已发布 Release.*v1\.0\.0/);
    assert.equal(requests[0].repo, "demo");
  }
});

test("release pagination finds later published versions; API errors fail closed", async () => {
  assert.equal((await validate([[{ ...release, draft: true }], [release]])).outputs.status, "success");
  const { outputs } = await validate([], { apiError: true });
  assert.equal(outputs.status, "error");
  assert.match(outputs.message, /无法检查插件 Release.*\n.*503/s);
});

test("modifications require releases; removal is exempt", async () => {
  assert.equal((await validate([[]], { type: "modify" })).outputs.status, "error");
  const modified = await validate([[release]], { type: "modify" });
  assert.equal(modified.outputs.status, "success");
  assert.match(modified.outputs.message, /适配 MaiBot 版本/);
  const removed = await validate([], { type: "remove", apiError: true });
  assert.equal(removed.outputs.status, "success");
  assert.equal(removed.requests.length, 0);
});

test("recheck failure comments still show a validated manifest range", async () => {
  let body;
  await new AsyncFunction("process", "github", "context", scriptFor("Add validation comment"))(
    { env: { VALIDATION_STATUS: "error", VALIDATION_MESSAGE: "插件尚未发布 Release", EVENT_NAME: "issue_comment", HOST_MIN_VERSION: "0.12.0", HOST_MAX_VERSION: "0.15.99" } },
    { rest: { issues: { createComment: async (comment) => { body = comment.body; } } } },
    { repo: { owner: "example", repo: "plugins" }, issue: { number: 7 } },
  );
  assert.match(body, /此为重新验证结果/);
  assert.match(body, /适配 MaiBot 版本（manifest 声明）：.*0\.12\.0 ～ 0\.15\.99/);
});
