const test = require('node:test');
const assert = require('node:assert/strict');
const { notifyReleaseReview, MARKER } = require('./notify_release_review.cjs');
function fixture({ organization = false } = {}) {
  const target = { id: 'demo.plugin', repositoryUrl: 'https://github.com/developer/plugin',
    version: '1.0.0', tag: 'v1.0.0', commit: 'a'.repeat(40) };
  const result = { schema_version: 2, plugin_id: target.id, repository_url: target.repositoryUrl,
    version: target.version, tag: target.tag, commit: target.commit,
    reviewed: true, decision: 'pass', summary: '审核说明', risks: [] };
  const comments = [];
  const github = { paginate: async () => comments, rest: {
    repos: { get: async () => ({ data: { owner: { type: organization ? 'Organization' : 'User', login: 'developer' } } }),
      getReleaseByTag: async ({ tag }) => {
        assert.equal(tag, target.tag);
        return { data: { author: { type: 'User', login: 'publisher' } } };
      } },
    issues: { listComments() {}, createComment: async ({ body }) => { comments.push({ body, user: { login: 'mai[bot]' } }); } },
  } };
  return { github, comments, result, params: { owner: 'market', repo: 'registry', issue_number: 1 },
    issue: { body: `<!-- plugin-release: ${JSON.stringify(target)} -->` }, botLogin: 'mai[bot]' };
}
test('成功收录才通知成功，同一审核单仅通知一次', async () => {
  const data = fixture();
  await notifyReleaseReview({ ...data, published: true });
  assert.match(data.comments[0].body, /@developer.*1.0.0.*已成功收录/);
  await notifyReleaseReview({ ...data, published: true });
  assert.equal(data.comments.length, 1);
});
test('收录失败不报成功，风险、证据缺失及无结果保留人工', async () => {
  const data = fixture();
  await notifyReleaseReview(data);
  assert.match(data.comments[0].body, /审核通过，但收录失败/);
  for (const change of [{ reviewed: false }, { risks: ['缺少审核说明'] }, { risks: ['存在风险'] }, { decision: 'manual_review' }, null]) {
    const pending = fixture();
    pending.result = change ? { ...pending.result, ...change } : null;
    await notifyReleaseReview({ ...pending, published: true });
    assert.match(pending.comments[0].body, /需维护者确认，尚未收录/);
    assert.doesNotMatch(pending.comments[0].body, /已成功收录|已拒绝/);
  }
});
test('组织仓库通知发布作者；外部伪造标记不阻止通知', async () => {
  const data = fixture({ organization: true });
  data.comments.push({ body: MARKER, user: { login: 'someone' } });
  await notifyReleaseReview({ ...data, published: true });
  assert.equal(data.comments.length, 2);
  assert.match(data.comments[1].body, /@publisher/);
  assert.doesNotMatch(data.comments[1].body, /@developer/);
});
test('结果身份不匹配时不发布开发者通知', async () => {
  const data = fixture();
  data.result.plugin_id = 'wrong';
  await assert.rejects(notifyReleaseReview(data), /审核插件不一致/);
  assert.equal(data.comments.length, 0);
});

test('被新版取代的旧审核结果不再通知开发者', async () => {
  const data = fixture();
  data.issue.body += '\n<!-- plugin-release-superseded: 2 -->';
  data.github.paginate = async () => assert.fail('不应继续发送旧单通知');
  await notifyReleaseReview(data);
  assert.equal(data.comments.length, 0);
});
