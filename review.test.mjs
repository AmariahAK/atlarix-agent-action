// node --test   (no dependencies)
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerRead, gitArgs, isReviewEvent, safePath } from "./review.mjs";

const SHA = "a".repeat(40);

test("a review is only the atlarix-review dispatch", () => {
  assert.equal(isReviewEvent({ action: "atlarix-review" }), true);
  assert.equal(isReviewEvent({ action: "atlarix-task" }), false);
  assert.equal(isReviewEvent(null), false);
});

test("paths: repo-relative only", () => {
  assert.equal(safePath("src/a.ts"), "src/a.ts");
  for (const bad of ["", "/etc/passwd", "../x", "a/../../b", "a//b", "-c", "a\u0000b", "x".repeat(1025), 5]) {
    assert.equal(safePath(bad), null, String(bad));
  }
});

test("each read is ONE fixed git command at the claimed commit; nothing else can be asked", () => {
  assert.deepEqual(gitArgs({ op: "blob", path: "src/a.ts" }, SHA), ["cat-file", "blob", `${SHA}:src/a.ts`]);
  assert.deepEqual(gitArgs({ op: "paths" }, SHA), ["ls-tree", "-r", "--name-only", SHA]);
  assert.deepEqual(gitArgs({ op: "grep", text: "--output=x", word: true, path: "src" }, SHA), [
    "grep", "-n", "-I", "-F", "-w", "-e", "--output=x", SHA, "--", "src",
  ]);
  assert.deepEqual(gitArgs({ op: "grep", text: "token" }, SHA), ["grep", "-n", "-I", "-F", "-e", "token", SHA]);
  // Anything else is refused, not run.
  assert.equal(gitArgs({ op: "blob", path: "../x" }, SHA), null);
  assert.equal(gitArgs({ op: "grep", text: "" }, SHA), null);
  assert.equal(gitArgs({ op: "grep", text: "a\u0000" }, SHA), null);
  assert.equal(gitArgs({ op: "grep", text: "x", path: "/abs" }, SHA), null);
  assert.equal(gitArgs({ op: "exec", cmd: "rm" }, SHA), null);
  assert.equal(gitArgs({ op: "paths" }, "HEAD"), null);
});

test("answers a real checkout: a file, a missing file, the path list, a grep, no matches", () => {
  const dir = mkdtempSync(join(tmpdir(), "atlarix-review-test-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.ts"), "export const token = read();\n");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "x");
  const sha = git("rev-parse", "HEAD");

  assert.deepEqual(answerRead({ id: 1, op: "blob", path: "src/a.ts" }, sha, dir), { id: 1, ok: true, out: "export const token = read();\n" });
  assert.deepEqual(answerRead({ id: 2, op: "blob", path: "nope.ts" }, sha, dir), { id: 2, ok: true, missing: true });
  assert.deepEqual(answerRead({ id: 3, op: "paths" }, sha, dir), { id: 3, ok: true, out: "README.md\nsrc/a.ts\n" });
  assert.deepEqual(answerRead({ id: 4, op: "grep", text: "token", word: true }, sha, dir), {
    id: 4,
    ok: true,
    out: `${sha}:src/a.ts:1:export const token = read();\n`,
  });
  assert.deepEqual(answerRead({ id: 5, op: "grep", text: "absent" }, sha, dir), { id: 5, ok: true, missing: true });
  assert.equal(answerRead({ id: 6, op: "exec", cmd: "id" }, sha, dir).ok, false);
});
