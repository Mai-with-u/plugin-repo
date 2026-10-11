const { parseReleaseIssue } = require('./release_review.cjs');
const { validateReleaseReview, passedReleases } = require('./release_review_result.cjs');

const MARKER = '<!-- mai-release-developer-notification -->';
const MISSING_EVIDENCE = ['缺少审核说明', '缺少源码检查状态', '缺少有效风险列表'];

async function notifyReleaseReview({ github, params, issue, result, published = false, botLogin }) {
  const comments = await github.paginate(github.rest.issues.listComments, { ...params, per_page: 100 });
  if (comments.some(comment => comment.user?.login === botLogin && comment.body?.includes(MARKER))) return;
  const batch = parseReleaseIssue(issue);
  if (result) validateReleaseReview(result, batch);
  const [owner, repo] = batch.repositoryUrl.slice('https://github.com/'.length).split('/');
  const { data: repository } = await github.rest.repos.get({ owner, repo });
  const developers = new Set();
  if (repository.owner.type === 'User') developers.add(repository.owner.login);
  else {
    for (const release of batch.releases) {
      const { data } = await github.rest.repos.getReleaseByTag({ owner, repo, tag: release.tag });
      if (data.author?.type === 'User') developers.add(data.author.login);
    }
  }
  if (!developers.size) throw new Error('无法确定发布开发者，未发送通知');
  const passed = new Set(result ? passedReleases(result).map(item => item.version) : []);
  const success = [], failed = [], pending = [];
  for (const release of batch.releases) {
    const review = result?.releases.find(item => item.version === release.version);
    if (passed.has(release.version)) (published ? success : failed).push(release.version);
    else if (review?.reviewed && review.risks.length && !review.risks.some(risk => MISSING_EVIDENCE.includes(risk))) failed.push(release.version);
    else pending.push(release.version);
  }
  const versions = values => values.length ? values.map(value => `\`${value}\``).join('、') : '无';
  await github.rest.issues.createComment({ ...params, body:
    `${MARKER}\n\n## Release 审核结果\n\n${[...developers].map(login => `@${login}`).join(' ')}，您的发布版本审核结果如下：\n\n` +
    `| 状态 | 版本 |\n| --- | --- |\n| ✅ 成功收录 | ${versions(success)} |\n| ❌ 未通过或收录失败 | ${versions(failed)} |\n| ⏳ 待确认 | ${versions(pending)} |\n\n` +
    (published ? '具体原因请查看本 Issue 的审核意见。需重新审核时，请联系维护者。' : '自动收录未完成，请维护者查看运行日志；具体审核意见见本 Issue。') });
}

module.exports = { notifyReleaseReview, MARKER };
