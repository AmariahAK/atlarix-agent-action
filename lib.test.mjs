// node --test   (no dependencies)
import assert from "node:assert/strict";
import { test } from "node:test";
import { byokProblem, childEnv, cliArgs, failureReason, ownKeyReport, parsePlan, ProgressTracker, relicPayload, relicTitle, stepText } from "./lib.mjs";

const base = {
  claim: { tier: "core-auto" },
  cliVersion: "latest",
  workspace: "/ws",
  promptFile: "/t/task.md",
  outputFile: "/t/summary.md",
  tokenFile: "/t/core-token",
  keyFile: "/t/provider-key",
};

test("a paid run talks to Atlarix Core with the job's token file, and never a key", () => {
  const args = cliArgs({ ...base, claim: { tier: "core-2" }, byok: null });
  assert.deepEqual(args.slice(args.indexOf("--provider-id"), args.indexOf("--provider-id") + 6), [
    "--provider-id", "compass", "--model", "core-2", "--core-token-file", "/t/core-token",
  ]);
  assert.ok(!args.includes("--api-key-file"));
});

test("an own-key run talks to the user's provider with a key FILE, and gets no Core token", () => {
  const args = cliArgs({ ...base, byok: { provider: "anthropic", model: "claude-x", key: "sk-secret" } });
  assert.deepEqual(args.slice(args.indexOf("--provider-id"), args.indexOf("--provider-id") + 6), [
    "--provider-id", "anthropic", "--model", "claude-x", "--api-key-file", "/t/provider-key",
  ]);
  assert.ok(!args.includes("--core-token-file"));
  assert.ok(!args.join(" ").includes("sk-secret"), "the key value is never on the command line");
});

test("the agent's environment carries no key, no action input, and no OIDC credentials", () => {
  const env = childEnv(
    {
      PATH: "/usr/bin",
      GITHUB_REPOSITORY: "acme/web",
      ATLARIX_PROVIDER_KEY: "sk-secret",
      ATLARIX_PROVIDER: "anthropic",
      ATLARIX_MODEL: "claude-x",
      "INPUT_PROVIDER-KEY": "sk-secret",
      INPUT_JOB_ID: "x",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "tok",
    },
    { ATLARIX_USER_DATA_DIR: "/t/userdata" },
  );
  assert.ok(!JSON.stringify(env).includes("sk-secret"));
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.GITHUB_REPOSITORY, "acme/web");
  assert.equal(env.ACTIONS_ID_TOKEN_REQUEST_URL, "");
  assert.equal(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, "");
  assert.ok(!Object.keys(env).some((k) => k.startsWith("INPUT_")));
  assert.equal(env.ATLARIX_USER_DATA_DIR, "/t/userdata");
});

test("an own-key run with something missing says exactly what to add", () => {
  assert.equal(byokProblem({ key: "k", provider: "anthropic", model: "m" }), null);
  const msg = byokProblem({ key: "", provider: "anthropic", model: "" });
  assert.match(msg, /ATLARIX_PROVIDER_KEY/);
  assert.match(msg, /ATLARIX_MODEL/);
  assert.doesNotMatch(msg, /variable ATLARIX_PROVIDER \(/);
  assert.match(byokProblem({ key: "k", provider: "not a provider!", model: "m" }), /isn't a provider id/);
});

test("an own-key run reports its provider and model, never the key; a paid run reports neither", () => {
  const r = ownKeyReport({ key: "sk-secret", provider: "deepseek", model: "deepseek-chat" });
  assert.deepEqual(r, { provider: "deepseek", model: "deepseek-chat" });
  assert.ok(!JSON.stringify(r).includes("sk-secret"));
  assert.deepEqual(ownKeyReport(null), {});
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
