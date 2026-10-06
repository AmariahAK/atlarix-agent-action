// Atlarix cloud agent — the runner side.
//
// 1. Prove where we are running (GitHub OIDC) and claim the job: prompt, the
//    model (paid Atlarix Auto, a paid Core tier, or "byok"), a job-scoped Core
//    token (none for an own-key run), a branch name.
// 2. Fetch the files attached to the request (Slack) into the runner's temp
//    folder, never the checkout, and hand them to the CLI with --attach.
// 3. Run the Atlarix CLI on the checkout. The credential (the Core token, or the
//    user's own provider key) goes in a file the CLI reads and deletes — never
//    into the environment, so the agent's own shell commands cannot see it.
//    While it runs, follow its trajectory file and post short progress (step
//    names, the plan) for the Slack card, at most every few seconds.
// 4. After the agent has EXITED: publish the pages it made (.atlarix/relics/)
//    instead of committing them, fetch a push token (scoped to this one repo),
//    commit, push, open the pull request, and report back — with a reason a
//    person can act on when it failed.
//
// No dependencies: Node 22's fetch, and git/npx from the runner image.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import {
  byokProblem,
  childEnv,
  cliArgs,
  failureReason,
  ownKeyReport,
  ProgressTracker,
  relicPayload,
  relicTitle,
} from "./lib.mjs";

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

/** A runner route that answers with bytes (an attachment). */
async function apiBytes(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await oidcToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The request's attachments, saved in the runner's temp folder; their paths. */
async function fetchAttachments(claim, dir) {
  const out = [];
  for (const f of claim.attachments ?? []) {
    try {
      const bytes = await apiBytes("/cloud/attachments", { job_id: JOB_ID, file_id: f.id });
      // Only a plain file name: never a path the request chose.
      const safe = `${String(f.id).replace(/[^\w-]/g, "")}-${basename(String(f.name ?? "file")).replace(/[^\w.-]+/g, "_")}`.slice(0, 120);
      const file = join(dir, safe);
      writeFileSync(file, bytes);
      out.push(file);
    } catch (e) {
      console.log(`::warning::Could not fetch attachment ${f.name}: ${e.message}`);
    }
  }
  return out;
}

/**
 * Run the CLI without blocking, following its trajectory: post progress at most
 * every PROGRESS_MS while something changed, and keep the end of stderr for the
 * failure reason. Resolves with the exit code.
 */
const PROGRESS_MS = 5_000;
function runAgent(args, env, trajectoryFile) {
  return new Promise((resolve) => {
    const tracker = new ProgressTracker();
    let stderrTail = "";
    let started = false;
    let offset = 0;
    let partial = "";
    let sentVersion = 0;
    let sending = false;
    const readNew = () => {
      if (!existsSync(trajectoryFile)) return;
      const size = statSync(trajectoryFile).size;
      if (size <= offset) return;
      const fd = openSync(trajectoryFile, "r");
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      const lines = (partial + buf.toString("utf8")).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "run_start") started = true;
          tracker.add(ev);
        } catch {
          /* a line cut mid-write is finished on the next read */
        }
      }
    };
    const post = async () => {
      if (sending || tracker.version === sentVersion) return;
      sending = true;
      const version = tracker.version;
      try {
        await api("/cloud/progress", { job_id: JOB_ID, ...tracker.report() });
        sentVersion = version;
      } catch (e) {
        // Progress is a courtesy; the run goes on without it.
        console.log(`progress not posted: ${e.message}`);
      } finally {
        sending = false;
      }
    };
    const timer = setInterval(() => {
      readNew();
      void post();
    }, PROGRESS_MS);

    const child = spawn("npx", args, { cwd: WORKSPACE, env, stdio: ["ignore", "inherit", "pipe"] });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-8_000);
    });
    child.on("close", async (code, signal) => {
      clearInterval(timer);
      readNew();
      await post();
      resolve({ code: code ?? 1, signal, stderrTail, started, tracker });
    });
    child.on("error", (e) => {
      stderrTail += `\n${e.message}`;
    });
  });
}

/**
 * Pages the agent made this run: new folders under .atlarix/relics/. Published
 * for the job's owner when Atlarix can (the Slack card links them), and taken
 * out of the working tree either way, so they never land in the pull request.
 */
async function publishRelics(claim) {
  const root = join(WORKSPACE, ".atlarix", "relics");
  if (!existsSync(root)) return [];
  // Untracked (or ignored) only: a relic the repository already tracks is the repository's business.
  const untracked = git(["status", "--porcelain", "--untracked-files=all", "--ignored", "--", ".atlarix/relics"])
    .split("\n")
    .filter((l) => l.startsWith("?? ") || l.startsWith("!! "))
    .map((l) => l.slice(3).split("/")[2])
    .filter(Boolean);
  const links = [];
  for (const slug of [...new Set(untracked)]) {
    const dir = join(root, slug);
    if (!existsSync(join(dir, "index.html"))) continue;
    if (claim.relics) {
      try {
        const files = [];
        const walk = (d) => {
          for (const name of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, name.name);
            if (name.isDirectory()) walk(p);
            else if (name.isFile()) files.push({ path: relative(dir, p).split("\\").join("/"), bytes: readFileSync(p) });
          }
        };
        walk(dir);
        const title = relicTitle(readFileSync(join(dir, "index.html"), "utf8"), slug);
        const { url } = await api("/cloud/relics", { job_id: JOB_ID, title, files: relicPayload(files.slice(0, 50)) });
        links.push({ title, url });
      } catch (e) {
        console.log(`::warning::Page ${slug} was not published: ${e.message}`);
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
  return links;
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

/** Added to the final report once the claim says whose model this run uses. */
let runIdentity = {};

async function report(body) {
  try {
    await api("/cloud/complete", { job_id: JOB_ID, ...runIdentity, ...body });
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
  runIdentity = ownKeyReport(byok);

  const tmp = mkdtempSync(join(tmpdir(), "atlarix-"));
  const promptFile = join(tmp, "task.md");
  const tokenFile = join(tmp, "core-token");
  const keyFile = join(tmp, "provider-key");
  const outputFile = join(tmp, "summary.md");
  const trajectoryFile = join(tmp, "trajectory.jsonl");
  const attachDir = join(tmp, "attachments");
  mkdirSync(attachDir);
  const attached = await fetchAttachments(claim, attachDir);
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
  const timeoutMs = 38 * 60 * 1000;
  const startedAt = Date.now();
  const agent = await runAgent(
    [
      ...cliArgs({ claim, cliVersion: CLI_VERSION, workspace: WORKSPACE, promptFile, outputFile, tokenFile, keyFile, byok }),
      "--trajectory-file",
      trajectoryFile,
      ...attached.flatMap((f) => ["--attach", f]),
    ],
    childEnv(process.env, {
      ATLARIX_USER_DATA_DIR: join(tmp, "userdata"),
      ...(byok ? {} : { ATLARIX_CORE_PROXY_URL: claim.core_proxy_url }),
    }),
    trajectoryFile,
  );
  const agentExit = agent.code;
  const why = () =>
    failureReason({
      exitCode: agentExit,
      stderrTail: agent.stderrTail,
      started: agent.started,
      trajectoryError: agent.tracker.lastError,
      timedOut: Date.now() - startedAt >= timeoutMs - 5_000,
    });
  const pages = await publishRelics(claim);
  const summary = existsSync(outputFile) ? readFileSync(outputFile, "utf8").trim() : "";

  const dirty = git(["status", "--porcelain"]) !== "";
  const changed = dirty || git(["rev-parse", "HEAD"]) !== startSha;
  if (!changed) {
    await report(
      agentExit === 0
        ? { status: "no_changes", summary }
        : { status: "failed", summary, error: `${why()} Nothing was changed.` },
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
      body: `${summary || "_The agent left no summary._"}${pages.length ? `\n\n**Pages from this run**\n${pages.map((p) => `- [${p.title.replace(/[\[\]]/g, "")}](${p.url})`).join("\n")}` : ""}\n\n---\n_Opened by the Atlarix cloud agent (job \`${JOB_ID}\`). Nothing is merged until the person who asked approves it._`,
    }),
  });
  const pr = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Opening the pull request failed (${res.status}): ${pr.message ?? ""}`);

  await report({
    status: "pr_opened",
    pr_number: pr.number,
    pr_url: pr.html_url,
    summary,
    ...(agentExit === 0 ? {} : { error: `The agent did not finish cleanly — ${why()} Review the changes carefully.` }),
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
