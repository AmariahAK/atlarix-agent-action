// node --test   (no dependencies)
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  childEnv,
  cliArgs,
  failureReason,
  outcome,
  parsePlan,
  ProgressTracker,
  relicNote,
  relicsMode,
  relicTitle,
  settleRelics,
  stepText,
  SUPPORTS,
} from "./lib.mjs";

const base = {
  claim: { tier: "core-auto" },
  cliVersion: "latest",
  workspace: "/ws",
  promptFile: "/t/task.md",
  outputFile: "/t/summary.md",
  tokenFile: "/t/core-token",
};

test("every run talks to Atlarix Core with the job's model and token FILE", () => {
  const args = cliArgs({ ...base, claim: { tier: "core-2" } });
  assert.deepEqual(args.slice(args.indexOf("--provider-id"), args.indexOf("--provider-id") + 6), [
    "--provider-id", "compass", "--model", "core-2", "--core-token-file", "/t/core-token",
  ]);
  assert.ok(!args.includes("--api-key-file"));
});

test("the agent's environment carries no action input and no OIDC credentials", () => {
  const env = childEnv(
    {
      PATH: "/usr/bin",
      GITHUB_REPOSITORY: "acme/web",
      "INPUT_CLI-VERSION": "latest",
      INPUT_JOB_ID: "x",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "tok",
    },
    { ATLARIX_USER_DATA_DIR: "/t/userdata" },
  );
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.GITHUB_REPOSITORY, "acme/web");
  assert.equal(env.ACTIONS_ID_TOKEN_REQUEST_URL, "");
  assert.equal(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, "");
  assert.ok(!Object.keys(env).some((k) => k.startsWith("INPUT_")));
  assert.equal(env.ATLARIX_USER_DATA_DIR, "/t/userdata");
});

test("a tool call is one short line; contents never leave the runner", () => {
  assert.equal(stepText("edit_file", { path: "src/login.ts", content: "SECRET" }), "Edited src/login.ts");
  assert.equal(stepText("run_command", { command: "npm test -- login" }), "Ran `npm test -- login`");
  assert.equal(stepText("plan", { operation: "write" }), null);
  assert.ok(!JSON.stringify(stepText("write_file", { path: "a", content: "SECRET" })).includes("SECRET"));
});

test("the plan follows write, update_step and append_step", () => {
  assert.deepEqual(parsePlan("# Fix\n- [x] Find the test\n- [~] Fix **it**\n- [ ] Run tests\nprose"), [
    { text: "Find the test", status: "completed" },
    { text: "Fix it", status: "in_progress" },
    { text: "Run tests", status: "pending" },
  ]);
  const t = new ProgressTracker();
  t.add({ type: "tool_use", toolName: "plan", status: "done", args: { operation: "write", content: "- [ ] A\n- [ ] B" } });
  t.add({ type: "tool_use", toolName: "plan", status: "done", args: { operation: "update_step", step_text: "a", state: "done" } });
  t.add({ type: "tool_use", toolName: "plan", status: "done", args: { operation: "append_step", step_text: "C" } });
  assert.deepEqual(t.report().plan, [
    { text: "A", status: "completed" },
    { text: "B", status: "pending" },
    { text: "C", status: "pending" },
  ]);
});

test("a step goes running → done in place, by tool call id", () => {
  const t = new ProgressTracker();
  t.add({ type: "tool_use", toolCallId: "c1", toolName: "read_file", status: "running", args: { path: "a.ts" } });
  t.add({ type: "tool_use", toolCallId: "c1", toolName: "read_file", status: "done", args: { path: "a.ts" } });
  t.add({ type: "assistant_text", text: "hi" });
  assert.deepEqual(t.report().steps, [{ text: "Read a.ts", status: "done" }]);
});

test("a failure says why, in words a person can act on", () => {
  assert.match(failureReason({ exitCode: 1, stderrTail: "npm ERR! code E404", started: false }), /couldn't be installed/);
  assert.match(failureReason({ exitCode: 1, stderrTail: "402 Payment Required: insufficient balance", started: true }), /balance ran out/);
  assert.match(failureReason({ exitCode: 1, stderrTail: "", started: true, timedOut: true }), /ran out of time/);
  assert.match(failureReason({ exitCode: 3, stderrTail: "line\n[atlarix-headless] boom happened", started: true }), /exit 3\): boom happened/);
  // Seen in a real run: the reason is the turn's error, not the summary line after it.
  const real = [
    "[atlarix-headless] the run ended on an error:",
    '  {"chatId":-1,"streamId":1,"error":"This model failed (Sign in to use Atlarix Core.)."}',
    "[atlarix-headless] completed=false workspace=/ws output=/t/summary.md",
  ].join("\n");
  assert.match(failureReason({ exitCode: 1, stderrTail: real, started: true }), /Sign in to use Atlarix Core/);
});

test("a relic's title comes from <title>, else the folder name", () => {
  assert.equal(relicTitle("<title> Login  report </title>", "slug"), "Login report");
  assert.equal(relicTitle("<h1>no title</h1>", "slug"), "slug");
});

// ─── relics in the pull request ─────────────────────────────────────────────

function repo() {
  const ws = mkdtempSync(join(tmpdir(), "relics-ws-"));
  const git = (args) => {
    const r = spawnSync("git", args, { cwd: ws, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const put = (p, s) => {
    mkdirSync(dirname(join(ws, p)), { recursive: true });
    writeFileSync(join(ws, p), s);
  };
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.test"]);
  git(["config", "user.name", "t"]);
  put("README.md", "hi");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  const record = (relics) => put(".atlarix/relics.json", JSON.stringify({ relics }));
  return { ws, git, put, record, has: (p) => existsSync(join(ws, p)) };
}

test("the relics input: only `exclude` leaves them out", () => {
  assert.equal(relicsMode(undefined), "include");
  assert.equal(relicsMode(""), "include");
  assert.equal(relicsMode(" Exclude "), "exclude");
  assert.equal(relicsMode("include"), "include");
});

test("include: a relic the run made stays for the commit; the record file doesn't", () => {
  const r = repo();
  r.put("relics/login/index.html", "<title>Login</title>");
  r.record({ login: { title: "Login flow", kind: "page", created: 1 } });
  const out = settleRelics({ workspace: r.ws, mode: "include", git: r.git });
  assert.deepEqual(out.included, [{ dir: "relics/login/", title: "Login flow" }]);
  assert.deepEqual(out.excluded, []);
  assert.ok(r.has("relics/login/index.html"));
  assert.ok(!r.has(".atlarix/relics.json"), "an untracked record stays out of the commit");
});

test("include: a record file the repository already tracks is kept", () => {
  const r = repo();
  r.record({});
  r.git(["add", "-A"]);
  r.git(["commit", "-qm", "track the record"]);
  r.put("relics/a/index.html", "a");
  r.record({ a: { title: "A" } });
  settleRelics({ workspace: r.ws, mode: "include", git: r.git });
  assert.match(readFileSync(join(r.ws, ".atlarix/relics.json"), "utf8"), /"A"/);
});

test("exclude: the run's relic is removed, and one the PR already had is put back as it was", () => {
  const r = repo();
  r.put("relics/old/index.html", "v1");
  r.git(["add", "-A"]);
  r.git(["commit", "-qm", "an earlier turn"]);
  r.put("relics/old/index.html", "v2");
  r.put("relics/old/extra.png", "x");
  r.put("relics/new/report.pdf", "%PDF");
  r.record({ old: { title: "Old" }, new: { title: "New" } });
  const out = settleRelics({ workspace: r.ws, mode: "exclude", git: r.git });
  assert.deepEqual(out.excluded.map((x) => x.dir).sort(), ["relics/new/", "relics/old/"]);
  assert.ok(!r.has("relics/new"));
  assert.equal(readFileSync(join(r.ws, "relics/old/index.html"), "utf8"), "v1");
  assert.ok(!r.has("relics/old/extra.png"));
  assert.equal(r.git(["status", "--porcelain"]), "");
});

test("a folder in relics/ that Atlarix didn't record is the user's, and is left alone", () => {
  const r = repo();
  r.put("relics/mine/notes.md", "mine");
  r.record({});
  const out = settleRelics({ workspace: r.ws, mode: "exclude", git: r.git });
  assert.deepEqual(out, { included: [], excluded: [], skipped: [] });
  assert.ok(r.has("relics/mine/notes.md"));
});

test("a file over the size limit is left out and named; a tracked one goes back to the committed version", () => {
  const r = repo();
  r.put("relics/v/clip.mp4", "small");
  r.git(["add", "-A"]);
  r.git(["commit", "-qm", "clip"]);
  r.put("relics/v/clip.mp4", "x".repeat(40));
  r.put("relics/v/big.mov", "x".repeat(40));
  r.put("relics/v/index.html", "ok");
  r.record({ v: { title: "Video" } });
  const out = settleRelics({ workspace: r.ws, mode: "include", git: r.git, maxBytes: 20 });
  assert.deepEqual(out.skipped.sort(), ["relics/v/big.mov", "relics/v/clip.mp4"]);
  assert.ok(!r.has("relics/v/big.mov"));
  assert.equal(readFileSync(join(r.ws, "relics/v/clip.mp4"), "utf8"), "small");
  assert.ok(r.has("relics/v/index.html"));
});

test("an older CLI's .atlarix/relics/ folder follows the same rule", () => {
  const r = repo();
  r.put(".atlarix/relics/plan/index.html", "<title>The plan</title>");
  const inc = settleRelics({ workspace: r.ws, mode: "include", git: r.git });
  assert.deepEqual(inc.included, [{ dir: ".atlarix/relics/plan/", title: "The plan" }]);
  const exc = settleRelics({ workspace: r.ws, mode: "exclude", git: r.git });
  assert.equal(exc.excluded.length, 1);
  assert.ok(!r.has(".atlarix/relics/plan"));
});

test("a recorded slug that isn't a plain folder name is ignored", () => {
  const r = repo();
  r.put("src/a.ts", "x");
  r.record({ "../src": { title: "x" }, "a/b": { title: "y" } });
  const out = settleRelics({ workspace: r.ws, mode: "exclude", git: r.git });
  assert.deepEqual(out.excluded, []);
  assert.ok(r.has("src/a.ts"));
});

test("the note says what happened to each relic, and how to opt out", () => {
  const n = relicNote({
    included: [{ dir: "relics/login/", title: "Login `flow`" }],
    excluded: [{ dir: "relics/x/", title: "X" }],
    skipped: ["relics/login/big.mp4"],
  });
  assert.match(n.summary, /relics\/login\//);
  assert.match(n.summary, /relics\/x\//);
  assert.match(n.summary, /relics\/login\/big\.mp4/);
  assert.doesNotMatch(n.summary, /`flow`/);
  assert.match(n.hint, /relics: exclude/);
  assert.equal(relicNote({ included: [], excluded: [{ dir: "relics/x/", title: "X" }], skipped: [] }).hint, "");
  assert.deepEqual(relicNote({ included: [], excluded: [], skipped: [] }), { summary: "", hint: "" });
});

test("a question runs the CLI read-only; a task doesn't", () => {
  const ask = cliArgs({ ...base, claim: { tier: "core-auto", mode: "ask" } });
  assert.deepEqual(ask.slice(ask.indexOf("--mode"), ask.indexOf("--mode") + 2), ["--mode", "ask"]);
  assert.ok(!cliArgs({ ...base, claim: { tier: "core-auto", mode: "build" } }).includes("--mode"));
});

test("a question never pushes, even when the agent changed files", () => {
  assert.deepEqual(outcome({ claim: { mode: "ask" }, agentExit: 0, changed: true }), { kind: "answer", ok: true });
  assert.deepEqual(outcome({ claim: { mode: "ask" }, agentExit: 1, changed: false }), { kind: "answer", ok: false });
});

test("a follow-up turn adds to its PR: no force, no new PR; a first turn force-pushes its own branch and opens one", () => {
  assert.deepEqual(outcome({ claim: { mode: "build", continue_pr: { number: 12, url: "u" } }, agentExit: 0, changed: true }), { kind: "push", force: false, openPr: false });
  assert.deepEqual(outcome({ claim: { mode: "build", continue_pr: null }, agentExit: 0, changed: true }), { kind: "push", force: true, openPr: true });
  assert.deepEqual(outcome({ claim: {}, agentExit: 0, changed: false }), { kind: "none", ok: true });
});

test("the claim says what this runner can do, so Atlarix refuses a job an older one would get wrong", () => {
  assert.deepEqual(SUPPORTS, ["continue", "ask"]);
});
