// node --test   (no dependencies)
import assert from "node:assert/strict";
import { test } from "node:test";
import { byokProblem, childEnv, cliArgs, ownKeyReport } from "./lib.mjs";

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
