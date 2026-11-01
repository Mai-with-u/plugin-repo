const assert = require('node:assert/strict');
const { VERSION } = require('./validate_manifest.cjs');
const { validateManifest } = require('./sync_plugin_versions.cjs');
const { parseReleaseIssue, recordReleaseSnapshot } = require('./release_review.cjs');

const MARKER = 'codex-mai-initial-release';

// Registration reviews inspect the published source, even when the branch has
// moved ahead. The snapshot is produced by the workflow, never by model output.
async function selectInitialRelease({ plugin, request }) {
  assert.match(plugin.repositoryUrl, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
  const base = `/repos/${plugin.repositoryUrl.slice('https://github.com/'.length)}`;
  const releases = [];
  for (let page = 1; ; page++) {
    const batch = await request(`${base}/releases?per_page=100&page=${page}`);
    releases.push(...batch.filter(item => !item.draft && item.published_at &&
      VERSION.test(item.tag_name.replace(/^v/, ''))));
    if (batch.length < 100) break;
  }
  releases.sort((a, b) => b.published_at.localeCompare(a.published_at) || b.id - a.id);
  const release = releases[0];
  assert.ok(release, '首次审核需要已发布的三段式版本 Release');
  let object = (await request(`${base}/git/ref/tags/${encodeURIComponent(release.tag_name)}`)).object;
  for (let depth = 0; object.type === 'tag'; depth++) {
    assert.ok(depth < 10, 'Tag 嵌套层级过多');
    assert.match(object.sha, /^[0-9a-f]{40}$/);
    object = (await request(`${base}/git/tags/${object.sha}`)).object;
  }
  assert.equal(object.type, 'commit', 'Tag 必须指向 commit');
  const target = { ...plugin, version: release.tag_name.replace(/^v/, ''), tag: release.tag_name, commit: object.sha };
  parseReleaseIssue({ body: `<!-- plugin-release: ${JSON.stringify(target)} -->` });
  const file = await request(`${base}/contents/_manifest.json?ref=${target.commit}`);
  assert.equal(file.type, 'file', '_manifest.json 必须是普通文件');
  assert.equal(file.encoding, 'base64');
  validateManifest(JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')), target.version);
  return target;
}

function initialReleaseMarker(target) {
  return `<!-- ${MARKER}: ${JSON.stringify(target)} -->\n`;
}

function reviewedInitialRelease({ comments, plugin, botLogin }) {
  assert.ok(botLogin, '缺少审核机器人身份');
  const activity = comments.filter(comment => comment.user?.login === botLogin && comment.user?.type === 'Bot' &&
    /^<!-- codex-mai-review(?: -->|-(?:start|failed): )/.test(comment.body || ''));
  const latest = activity.at(-1);
  if (!latest) return null; // Older registrations have no reusable snapshot.
  assert.match(latest.body, /^<!-- codex-mai-review -->\r?\n/, '最新首次审核尚未完成，请等待或重新审核');
  const header = latest.body.match(/^<!-- codex-mai-review -->\r?\n<!-- codex-mai-review-run: \d+:\d+ -->\r?\n<!-- codex-mai-review-commit: ([0-9a-f]{40}) -->\r?\n/);
  if (!header) return null;
  // Only accept the metadata immediately after the workflow's fixed header.
  const match = latest.body.slice(header[0].length).match(/^<!-- codex-mai-initial-release: (.+) -->\r?\n/);
  if (!match) return null;
  const target = parseReleaseIssue({ body: `<!-- plugin-release: ${match[1]} -->` });
  assert.equal(target.id, plugin.id, '首次审核插件 ID 已改变，请重新审核');
  assert.equal(target.repositoryUrl, plugin.repositoryUrl, '首次审核仓库已改变，请重新审核');
  assert.equal(target.commit, header[1], '首次审核 commit 不一致');
  return target;
}

async function recordInitialRelease({ root, plugin, target, request }) {
  if (!target) return;
  assert.equal(target.id, plugin.id, '首次审核插件 ID 不一致');
  assert.equal(target.repositoryUrl, plugin.repositoryUrl, '首次审核仓库不一致');
  await recordReleaseSnapshot({ root, data: target, request });
}

module.exports = { selectInitialRelease, initialReleaseMarker, reviewedInitialRelease, recordInitialRelease };
