const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { checkoutReleaseReviews } = require('./checkout_release_reviews.cjs');

test('批次分别检出固定源码，并生成基线和相邻版本变更', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  const git = args => execFileSync('git', args, { cwd: source, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'test']);
  git(['config', 'user.email', 'test@example.com']);
  const commits = [];
  for (const content of ['baseline', 'first', 'second']) {
    fs.writeFileSync(path.join(source, 'plugin.py'), `${content}\n`);
    git(['add', 'plugin.py']);
    git(['commit', '-m', content]);
    commits.push(git(['rev-parse', 'HEAD']));
  }
  git(['clone', source, path.join(root, 'plugin-under-review')]);
  checkoutReleaseReviews(root, { id: 'test.demo', repositoryUrl: 'https://github.com/test/demo',
    base_commit: commits[0], releases: [
      { version: '2.0.0', tag: 'v2.0.0', commit: commits[2] },
      { version: '1.0.0', tag: 'v1.0.0', commit: commits[1] },
    ] });
  assert.equal(fs.readFileSync(path.join(root, 'plugin-release-under-review/1.0.0/plugin.py'), 'utf8').trim(), 'first');
  assert.equal(fs.readFileSync(path.join(root, 'plugin-release-under-review/2.0.0/plugin.py'), 'utf8').trim(), 'second');
  assert.match(fs.readFileSync(path.join(root, 'plugin-release-diffs/1.0.0.patch'), 'utf8'), /-baseline\r?\n\+first/);
  assert.match(fs.readFileSync(path.join(root, 'plugin-release-diffs/2.0.0.patch'), 'utf8'), /-first\r?\n\+second/);
});
