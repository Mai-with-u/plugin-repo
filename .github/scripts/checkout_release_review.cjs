const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseReleaseIssue } = require('./release_review.cjs');

function checkoutReleaseReview(root, target) {
  const release = parseReleaseIssue({ body: `<!-- plugin-release: ${JSON.stringify(target)} -->` });
  const cwd = path.join(root, 'plugin-under-review');
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  git(['fetch', '--no-tags', '--depth=1', 'origin', release.commit]);
  git(['checkout', '--detach', release.commit]);
  if (release.base_commit) git(['fetch', '--no-tags', '--depth=1', 'origin', release.base_commit]);
  const diff = release.base_commit
    ? git(['diff', '--no-ext-diff', '--no-textconv', release.base_commit, release.commit, '--'])
    : '无已收录基线，请完整检查该版本源码。\n';
  fs.writeFileSync(path.join(root, 'plugin-release.patch'), diff);
}

if (require.main === module) {
  checkoutReleaseReview(process.cwd(), JSON.parse(fs.readFileSync('mai-release-target.json', 'utf8')));
}
module.exports = { checkoutReleaseReview };
