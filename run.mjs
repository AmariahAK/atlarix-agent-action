// Atlarix cloud agent — the runner side.
//
// 1. Prove where we are running (GitHub OIDC) and claim the job: prompt, the
//    model (paid Atlarix Auto, a paid Core tier, or "byok"), a job-scoped Core
//    token (none for an own-key run), a branch name.
// 2. Run the Atlarix CLI on the checkout. The credential (the Core token, or the
//    user's own provider key) goes in a file the CLI reads and deletes — never
//    into the environment, so the agent's own shell commands cannot see it.
// 3. After the agent has EXITED, fetch a push token (scoped to this one repo),
//    commit, push, open the pull request, and report back.
//
// No dependencies: Node 22's fetch, and git/npx from the runner image.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { byokProblem, childEnv, cliArgs } from "./lib.mjs";

const JOB_ID = process.env.ATLARIX_JOB_ID ?? "";
const API = (process.env.ATLARIX_API_URL ?? "").replace(/\/+$/, "");
const CLI_VERSION = process.env.ATLARIX_CLI_VERSION || "latest";
const REPO = process.env.GITHUB_REPOSITORY ?? "";
const BASE = process.env.GITHUB_REF_NAME ?? "";
const WORKSPACE = process.env.GITHUB_WORKSPACE ?? process.cwd();

// The user's own key (only used when the job says "byok"). Taken out of this
// process's environment at once, so nothing started from here can inherit it.
const BYOK_INPUT = {
  key: process.env.ATLARIX_PROVIDER_KEY ?? "",
  provider: (process.env.ATLARIX_PROVIDER ?? "").trim().toLowerCase(),
  model: (process.env.ATLARIX_MODEL ?? "").trim(),
};
delete process.env.ATLARIX_PROVIDER_KEY;

/** Keep a secret out of the Actions log even if something echoes it. */
function mask(secret) {
  if (secret) process.stdout.write(`::add-mask::${secret}\n`);
}

function fail(message) {
  process.stdout.write(`::error::${message}\n`);
}

async function oidcToken() {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !token) {
    throw new Error("No OIDC token available. The workflow needs `permissions: id-token: write`.");
  }
  const res = await fetch(`${url}&audience=atlarix-cloud`, { headers: { Authorization: `bearer ${token}` } });
  if (!res.ok) throw new Error(`GitHub refused an OIDC token (${res.status}).`);
  const { value } = await res.json();
  mask(value);
  return value;
}

/** Every call gets a FRESH OIDC token: they live minutes, a run lives longer. */
async function api(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await oidcToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* reported below */
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${json.error ?? text.slice(0, 200)}`);
  return json;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: WORKSPACE, stdio: "inherit", ...opts });
  return r.status ?? 1;
}

function git(args, opts = {}) {
  const r = spawnSync("git", args, { cwd: WORKSPACE, encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || "").trim().slice(0, 300)}`);
  return (r.stdout || "").trim();
}

async function report(body) {
  try {
    await api("/cloud/complete", { job_id: JOB_ID, ...body });
  } catch (e) {
    fail(`Could not report the result to Atlarix: ${e.message}`);
  }
}

async function main() {
  if (!/^[0-9a-f-]{36}$/i.test(JOB_ID)) throw new Error("Missing or malformed job id.");
  if (!/^https:\/\//.test(API)) throw new Error("api-url must be https.");

  mask(BYOK_INPUT.key);
  const claim = await api("/cloud/claim", { job_id: JOB_ID });
  if (claim.run_token) mask(claim.run_token);

  // The job decides the model, not this workflow: a key set here is ignored on
  // a paid run, and an own-key run never gets a Core token.
  const byok = claim.byok ? BYOK_INPUT : null;
  if (byok) {
    const problem = byokProblem(byok);
    if (problem) throw new Error(problem);
  }

  const tmp = mkdtempSync(join(tmpdir(), "atlarix-"));
  const promptFile = join(tmp, "task.md");
  const tokenFile = join(tmp, "core-token");
  const keyFile = join(tmp, "provider-key");
  const outputFile = join(tmp, "summary.md");
  writeFileSync(promptFile, claim.prompt);
  if (byok) writeFileSync(keyFile, byok.key, { mode: 0o600 });
  else writeFileSync(tokenFile, claim.run_token, { mode: 0o600 });

  // The repository's own preparation step, if it has one (the Codex pattern):
  // install dependencies, start a database, whatever the tests need.
  const setup = join(WORKSPACE, ".atlarix", "cloud-setup.sh");
  if (existsSync(setup)) {
    console.log("Running .atlarix/cloud-setup.sh");
    if (run("bash", [setup]) !== 0) throw new Error(".atlarix/cloud-setup.sh failed.");
  }

  // Recorded so a change the agent COMMITTED itself (it is told not to, but a
  // model may) still counts as a change rather than "nothing happened".
  const startSha = git(["rev-parse", "HEAD"]);

  console.log(byok ? `Running Atlarix on your own key (${byok.provider} · ${byok.model}) on ${REPO}` : `Running Atlarix (${claim.tier}) on ${REPO}`);
  const agentExit = run(
    "npx",
    cliArgs({ claim, cliVersion: CLI_VERSION, workspace: WORKSPACE, promptFile, outputFile, tokenFile, keyFile, byok }),
    {
      env: childEnv(process.env, {
        ATLARIX_USER_DATA_DIR: join(tmp, "userdata"),
        ...(byok ? {} : { ATLARIX_CORE_PROXY_URL: claim.core_proxy_url }),
      }),
    },
  );
  const summary = existsSync(outputFile) ? readFileSync(outputFile, "utf8").trim() : "";

  const dirty = git(["status", "--porcelain"]) !== "";
  const changed = dirty || git(["rev-parse", "HEAD"]) !== startSha;
  if (!changed) {
    await report(
      agentExit === 0
        ? { status: "no_changes", summary }
        : { status: "failed", summary, error: "The agent stopped before finishing and changed nothing." },
    );
    return agentExit === 0 ? 0 : 1;
  }

  // Only now, with the agent gone, does a credential that can write exist.
  const { token, branch } = await api("/cloud/push-token", { job_id: JOB_ID });
  mask(token);
  const auth = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  mask(auth);

  git(["config", "user.name", "atlarix[bot]"]);
  git(["config", "user.email", "atlarix[bot]@users.noreply.github.com"]);
  git(["checkout", "-B", branch]);
  const title = (summary.split("\n").find((l) => l.trim()) ?? "").replace(/^#+\s*/, "").slice(0, 72) || "Changes from Atlarix";
  if (dirty) {
    git(["add", "-A"]);
    git(["commit", "-m", `${title}\n\nAtlarix cloud agent, job ${JOB_ID}.`]);
  }
  // The token rides a one-off header, never the remote URL, so it is not
  // written to .git/config and cannot appear in a URL in an error message.
  git(["-c", `http.https://github.com/.extraheader=${auth}`, "push", "--force", "origin", `HEAD:refs/heads/${branch}`]);

  const res = await fetch(`https://api.github.com/repos/${REPO}/pulls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title,
      head: branch,
      base: BASE,
      body: `${summary || "_The agent left no summary._"}\n\n---\n_Opened by the Atlarix cloud agent (job \`${JOB_ID}\`). Nothing is merged until the person who asked approves it._`,
    }),
  });
  const pr = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Opening the pull request failed (${res.status}): ${pr.message ?? ""}`);

  await report({
    status: "pr_opened",
    pr_number: pr.number,
    pr_url: pr.html_url,
    summary,
    ...(agentExit === 0 ? {} : { error: "The agent did not finish cleanly; review the changes carefully." }),
  });
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch(async (e) => {
    fail(e.message);
    if (/^[0-9a-f-]{36}$/i.test(JOB_ID) && API) await report({ status: "failed", error: e.message });
    process.exit(1);
  });
