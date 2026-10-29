// node --test   (no dependencies)
import assert from "node:assert/strict";
import { test } from "node:test";
import { childEnv, cliArgs, failureReason, outcome, parsePlan, ProgressTracker, relicPayload, relicTitle, stepText, SUPPORTS } from "./lib.mjs";

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

test("relic files: text as text, images as base64; the title from <title>", () => {
  const p = relicPayload([
    { path: "index.html", bytes: Buffer.from("<h1>x</h1>") },
    { path: "img/a.png", bytes: Buffer.from([0x89, 0x50]) },
  ]);
  assert.deepEqual(p[0], { path: "index.html", content: "<h1>x</h1>" });
  assert.equal(p[1].encoding, "base64");
  assert.equal(relicTitle("<title> Login  report </title>", "slug"), "Login report");
  assert.equal(relicTitle("<h1>no title</h1>", "slug"), "slug");
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

test("a commit names the Atlarix agent as co-author when the input is on, and never agent@atlarix.dev", async () => {
  const { commitMessage, coAuthorEnabled, CO_AUTHOR_TRAILER } = await import("./lib.mjs");
  const on = commitMessage({ title: "Fix login", jobId: "j1", coAuthor: true });
  assert.equal(on, `Fix login\n\nAtlarix cloud agent, job j1.\n\n${CO_AUTHOR_TRAILER}`);
  assert.equal(CO_AUTHOR_TRAILER, "Co-authored-by: atlarix-agent <261929375+atlarix-agent@users.noreply.github.com>");
  assert.ok(!on.includes("agent@atlarix.dev"));
  const off = commitMessage({ title: "Fix login", jobId: "j1", coAuthor: false });
  assert.equal(off, "Fix login\n\nAtlarix cloud agent, job j1.");
  assert.ok(!off.includes("Co-authored-by"));
  for (const v of [undefined, "", "true", "True", " yes "]) assert.equal(coAuthorEnabled(v), true, String(v));
  for (const v of ["false", "FALSE", "0", "no", "off"]) assert.equal(coAuthorEnabled(v), false, v);
});

test("the thread's session id reaches the CLI only when it is the opaque 32-hex value", async () => {
  const { coreSessionFrom } = await import("./lib.mjs");
  const id = "0123456789abcdef0123456789abcdef";
  assert.equal(coreSessionFrom({ core_session: id }), id);
  assert.equal(coreSessionFrom({}), undefined);
  assert.equal(coreSessionFrom({ core_session: "ABCDEF" }), undefined);
  assert.equal(coreSessionFrom({ core_session: `${id}\n` }), undefined);
  assert.equal(coreSessionFrom({ core_session: "job-123;rm -rf" }), undefined);
});

test("helpers the agent starts show as helpers, and a helper's own calls are not counted twice", () => {
  const t = new ProgressTracker();
  t.add({ type: "tool_use", toolCallId: "p1", toolName: "task", status: "running", args: { description: "channels", prompt: "SECRET" } });
  t.add({ type: "tool_use", toolCallId: "p2", toolName: "task", status: "running", args: { description: "PR history", prompt: "SECRET" } });
  // the helper's own calls: an id of their own and the delegation they belong to (15.12 CLI)
  t.add({ type: "tool_use", id: "n1", parentDelegationId: "d1", toolName: "grep", status: "running", args: { pattern: "login" } });
  t.add({ type: "tool_use", id: "n1", parentDelegationId: "d1", toolName: "grep", status: "done", args: { pattern: "login" } });
  // an older CLI writes a helper's calls with no id at all
  t.add({ type: "tool_use", toolName: "read_file", status: "running", args: { path: "a.ts" } });
  t.add({ type: "tool_use", toolName: "read_file", status: "done", args: { path: "a.ts" } });
  t.add({ type: "tool_use", toolCallId: "p1", toolName: "task", status: "done", args: { description: "channels", prompt: "SECRET" } });
  const r = t.report();
  assert.deepEqual(r.steps, [
    { text: "Helper done: channels", status: "done" },
    { text: "Started a helper: PR history", status: "running" },
    { text: "Helper: Searched for login", status: "done" },
    { text: "Read a.ts", status: "done" },
  ]);
  assert.deepEqual(r.helpers, [
    { text: "channels", status: "done" },
    { text: "PR history", status: "running" },
  ]);
  assert.ok(!JSON.stringify(r).includes("SECRET"));
});
