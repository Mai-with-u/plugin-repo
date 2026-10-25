const test = require('node:test');
const assert = require('node:assert/strict');
const { notifyReleaseReview, MARKER } = require('./notify_release_review.cjs');

function fixture({ organization = false } = {}) {
  const batch = { id: 'demo.plugin', repositoryUrl: 'https://github.com/developer/plugin',
    releases: ['1.0.0', '1.1.0', '1.2.0'].map(version => ({ version, tag: version, commit: 'a'.repeat(40) })) };
  const result = { schema_version: 1, plugin_id: batch.id, repository_url: batch.repositoryUrl,
    releases: batch.releases.map((release, index) => ({ ...release, reviewed: index !== 2,
      decision: index ? 'manual_review' : 'pass', summary: '审核说明', risks: index === 1 ? ['存在风险'] : [] })) };
  const comments = [];
  const github = { paginate: async () => comments, rest: {
    repos: { get: async () => ({ data: { owner: { type: organization ? 'Organization' : 'User', login: 'developer' } } }),
      getReleaseByTag: async () => ({ data: { author: { type: 'User', login: 'publisher' } } }) },
    issues: { listComments() {}, createComment: async ({ body }) => { comments.push({ body, user: { login: 'mai[bot]' } }); } },
  } };
  return { github, comments, result, params: { owner: 'market', repo: 'registry', issue_number: 1 },
    issue: { body: `<!-- plugin-release: ${JSON.stringify(batch)} -->` }, botLogin: 'mai[bot]' };
}

test('通知将同批次未通过和依据不足版本列为拒绝', async () => {
  const data = fixture();
  await notifyReleaseReview({ ...data, published: true });
  assert.equal(data.comments.length, 1);
  const { body } = data.comments[0];
  assert.match(body, /@developer/);
  assert.match(body, /成功收录 \| `1.0.0`/);
  assert.match(body, /未通过或收录失败 \| `1.1.0`、`1.2.0`/);
  assert.match(body, /待确认 \| 无/);
  await notifyReleaseReview({ ...data, published: true });
  assert.equal(data.comments.length, 1);
});

test('收录失败不会报成功，缺失审核依据保留为待确认', async () => {
  const data = fixture();
  data.result.releases[1].risks = ['缺少审核说明'];
  await notifyReleaseReview(data);
  assert.match(data.comments[0].body, /成功收录 \| 无/);
  assert.match(data.comments[0].body, /未通过或收录失败 \| `1.0.0`/);
  assert.match(data.comments[0].body, /待确认 \| `1.1.0`、`1.2.0`/);
});

test('最新 Release 未通过时通知仍保留依据不足版本为待确认', async () => {
  const data = fixture();
  const batch = JSON.parse(data.issue.body.match(/<!-- plugin-release: (.+) -->/)[1]);
  batch.releases.reverse();
  data.issue.body = `<!-- plugin-release: ${JSON.stringify(batch)} -->`;
  await notifyReleaseReview({ ...data, published: true });
  assert.match(data.comments[0].body, /成功收录 \| `1.0.0`/);
  assert.match(data.comments[0].body, /待确认 \| `1.2.0`/);
});

test('组织仓库通知发布作者，合并重复提及；外部伪造标记不阻止通知', async () => {
  const data = fixture({ organization: true });
  data.comments.push({ body: MARKER, user: { login: 'someone' } });
  await notifyReleaseReview({ ...data, published: true });
  assert.equal(data.comments.length, 2);
  assert.equal((data.comments[1].body.match(/@publisher/g) || []).length, 1);
  assert.doesNotMatch(data.comments[1].body, /@developer/);
});

test('结果身份不匹配时不发布开发者通知', async () => {
  const data = fixture();
  data.result.plugin_id = 'wrong';
  await assert.rejects(notifyReleaseReview(data), /审核插件不一致/);
  assert.equal(data.comments.length, 0);
});
