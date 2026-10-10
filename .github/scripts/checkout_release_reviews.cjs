const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseReleaseIssue } = require('./release_review.cjs');

function checkoutReleaseReviews(root, targets) {
  const batch = parseReleaseIssue({ body: `<!-- plugin-release: ${JSON.stringify(targets)} -->` });
  const cwd = path.join(root, 'plugin-under-review');
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const commits = new Set([...batch.releases.map(item => item.commit), batch.base_commit].filter(Boolean));
  for (const commit of commits) git(['fetch', '--no-tags', '--depth=1', 'origin', commit]);
  fs.mkdirSync(path.join(root, 'plugin-release-under-review'), { recursive: true });
  fs.mkdirSync(path.join(root, 'plugin-release-diffs'), { recursive: true });
  let baseline = batch.base_commit;
  for (const release of [...batch.releases].reverse()) {
    git(['worktree', 'add', '--detach', path.join(root, 'plugin-release-under-review', release.version), release.commit]);
    const diff = baseline
      ? git(['diff', '--no-ext-diff', '--no-textconv', baseline, release.commit, '--'])
      : '无已收录基线，请完整检查该版本源码。\n';
    fs.writeFileSync(path.join(root, 'plugin-release-diffs', `${release.version}.patch`), diff);
    baseline = release.commit;
  }
}

if (require.main === module) {
  checkoutReleaseReviews(process.cwd(), JSON.parse(fs.readFileSync('mai-release-targets.json', 'utf8')));
}
module.exports = { checkoutReleaseReviews };
