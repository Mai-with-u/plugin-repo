const assert = require("node:assert/strict");
const test = require("node:test");
const { countReviews, MAX_REVIEWS } = require("./mai_review_state.js");
const bot = (body) => ({ user: { type: "Bot" }, body });
const start = (run) => bot(`<!-- codex-mai-review-start: ${run} -->\n审核中`);
const result = (run) => bot(`<!-- codex-mai-review -->\n<!-- codex-mai-review-run: ${run} -->\n审核意见`);

test("start and result count as one review; failed attempts count too", () => {
  assert.equal(countReviews([
    start("100:1"), result("100:1"),
    start("101:1"), bot("<!-- codex-mai-review-failed: 101:1 -->"),
  ]), 2);
});

test("historical reviews count alongside new reviews", () => {
  assert.equal(countReviews([
    bot("<!-- codex-mai-review -->\n旧审核"),
    bot("<!-- codex-mai-review -->\n另一条旧审核"),
    start("100:1"), result("100:1"),
  ]), 3);
});

test("user-supplied or quoted markers cannot consume the quota", () => {
  assert.equal(countReviews([
    { user: { type: "User" }, body: "<!-- codex-mai-review-start: 100:1 -->" },
    bot("引用：\n<!-- codex-mai-review-start: 100:1 -->"),
    bot("普通机器人评论"),
  ]), 0);
});

test("reruns count separately and eight attempts exhaust the quota", () => {
  const comments = Array.from({ length: MAX_REVIEWS }, (_, i) => start(`100:${i + 1}`));
  assert.equal(countReviews(comments.slice(0, 7)), 7);
  assert.equal(countReviews(comments), 8);
  assert.equal(MAX_REVIEWS, 8);
});

test("results retain the attempt count if a start comment is missing", () => {
  assert.equal(countReviews([result("100:1"), bot("<!-- codex-mai-review-failed: 101:1 -->")]), 2);
});
