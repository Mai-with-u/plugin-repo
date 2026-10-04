const MAX_REVIEWS = 8;

function countReviews(comments) {
  const startedRuns = new Set();
  let legacyReviews = 0;
  for (const comment of comments) {
    // Only workflow/app comments can reserve an attempt. Ignore quoted markers
    // in user comments and review text.
    if (comment.user?.type !== "Bot") continue;
    const body = comment.body || "";
    const started = body.match(/^<!-- codex-mai-review-start: (\d+:\d+) -->/);
    const completed = body.match(/^<!-- codex-mai-review -->\r?\n<!-- codex-mai-review-run: (\d+:\d+) -->/);
    const failed = body.match(/^<!-- codex-mai-review-failed: (\d+:\d+) -->/);
    const run = started?.[1] || completed?.[1] || failed?.[1];
    if (run) {
      startedRuns.add(run);
    } else if (body.startsWith("<!-- codex-mai-review -->")) {
      legacyReviews += 1;
    }
  }
  return legacyReviews + startedRuns.size;
}

module.exports = { countReviews, MAX_REVIEWS };
