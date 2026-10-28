const { parseReleaseIssue } = require('./release_review.cjs');
const { validateReleaseReview, isReleasePassed } = require('./release_review_result.cjs');

const MARKER = '<!-- mai-release-developer-notification -->';

async function notifyReleaseReview({ github, params, issue, result, published = false, botLogin }) {
  const comments = await github.paginate(github.rest.issues.listComments, { ...params, per_page: 100 });
  if (comments.some(comment => comment.user?.login === botLogin && comment.body?.includes(MARKER))) return;
  const release = parseReleaseIssue(issue);
  if (result) validateReleaseReview(result, release);
  const [owner, repo] = release.repositoryUrl.slice('https://github.com/'.length).split('/');
  const { data: repository } = await github.rest.repos.get({ owner, repo });
  let developer;
  if (repository.owner.type === 'User') developer = repository.owner.login;
  else {
    const { data } = await github.rest.repos.getReleaseByTag({ owner, repo, tag: release.tag });
    if (data.author?.type === 'User') developer = data.author.login;
  }
  if (!developer) throw new Error('无法确定发布开发者，未发送通知');
  const status = result && isReleasePassed(result)
    ? (published ? '✅ 已成功收录' : '❌ 审核通过，但收录失败')
    : '⏳ 需维护者确认，尚未收录';
  await github.rest.issues.createComment({ ...params, body:
    `${MARKER}\n\n## Release 审核结果\n\n@${developer}，版本 \`${release.version}\`：${status}。\n\n` +
    (published ? '具体原因请查看本 Issue 的审核意见。需重新审核时，请联系维护者。' : '自动收录未完成，请维护者查看运行日志；具体审核意见见本 Issue。') });
}

module.exports = { notifyReleaseReview, MARKER };
