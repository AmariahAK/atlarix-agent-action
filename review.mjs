// Atlarix pull-request review — the runner side (opt-in: `review_in_actions: true`
// in the repository's .atlarix.md).
//
// The review itself runs on Atlarix's side: the model, the findings and the
// comment. This runner is only a READ-ONLY CHECKOUT of the pull request at its
// head commit (the workflow checked it out, depth 1, no credentials kept).
// Nothing in the pull request is installed or run.
//
// 1. Claim the review with GitHub OIDC, naming the commit checked out.
// 2. Long-poll Atlarix for reads and answer each with ONE fixed git command at
//    that commit: a file (cat-file), the path list (ls-tree), a fixed-string
//    grep. No shell; every argument is checked; anything else is refused.
// 3. Exit when Atlarix says the review is done, or at the hard cap.
//
// No token for the model or for writing ever reaches this runner.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SHA_RE = /^[0-9a-f]{40}$/;
/** Exit no later than this, whatever happens (the workflow's own cap is 15 minutes). */
const HARD_CAP_MS = 14 * 60_000;
/** One read's output; a bigger file is read through the API instead. */
const MAX_OUT_BYTES = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;

export function isReviewEvent(event) {
  return event?.action === "atlarix-review";
}

/** A repo-relative path, or null. */
export function safePath(p) {
  if (typeof p !== "string" || !p || p.length > 1024) return null;
  if (p.includes("\u0000") || p.startsWith("/") || p.startsWith("-") || p.includes("\\")) return null;
  for (const s of p.split("/")) if (s === "" || s === "." || s === "..") return null;
  return p;
}

/** The ONE git command for a read, at `sha`; null for anything not allowed. */
export function gitArgs(req, sha) {
  if (!SHA_RE.test(String(sha))) return null;
  switch (req?.op) {
    case "blob": {
      const path = safePath(req.path);
      return path ? ["cat-file", "blob", `${sha}:${path}`] : null;
    }
    case "paths":
      return ["ls-tree", "-r", "--name-only", sha];
    case "grep": {
      const text = req.text;
      if (typeof text !== "string" || !text || text.length > 1000 || text.includes("\u0000")) return null;
      const args = ["grep", "-n", "-I", "-F", ...(req.word === true ? ["-w"] : []), "-e", text, sha];
      if (req.path !== undefined) {
        const path = safePath(req.path);
        if (!path) return null;
        args.push("--", path);
      }
      return args;
    }
    default:
      return null;
  }
}

/** Run one read; the answer Atlarix expects. */
export function answerRead(req, sha, cwd) {
  const args = gitArgs(req, sha);
  if (!args) return { id: req.id, ok: false, error: "read not allowed" };
  const r = spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_OUT_BYTES,
    timeout: GIT_TIMEOUT_MS,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GIT_TERMINAL_PROMPT: "0" },
  });
  if (r.error) return { id: req.id, ok: false, error: String(r.error.message).slice(0, 200) };
  // A path that isn't at this commit, or a grep with no matches: an answer.
  if (req.op === "grep" && r.status === 1) return { id: req.id, ok: true, missing: true };
  if (req.op === "blob" && r.status === 128) return { id: req.id, ok: true, missing: true };
  if (r.status !== 0) return { id: req.id, ok: false, error: (r.stderr || `git exited ${r.status}`).trim().slice(0, 200) };
  return { id: req.id, ok: true, out: r.stdout };
}

async function post(url, auth, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* reported below */
  }
  return { status: res.status, json };
}

/**
 * The review run. `oidcToken` and `mask` come from run.mjs; returns the exit code.
 * Exits 0 whenever Atlarix can carry on without us (it reads through the API).
 */
export async function runReview({ jobId, api, workspace, oidcToken, mask }) {
  const startedAt = Date.now();
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" });
  const sha = (head.stdout || "").trim();
  if (!SHA_RE.test(sha)) {
    console.log("::error::No checkout to review (git rev-parse HEAD failed).");
    return 1;
  }

  const claim = await post(`${api}/review/runner/claim`, await oidcToken(), { job_id: jobId, head_sha: sha });
  if (claim.status !== 200 || typeof claim.json.secret !== "string") {
    // Superseded, already claimed, or a commit mismatch: Atlarix reviews through the API.
    console.log(`Atlarix did not hand this runner the review (${claim.status} ${claim.json.error ?? ""}); it is reviewed without it.`);
    return 0;
  }
  const secret = claim.json.secret;
  mask(secret);
  console.log(`Serving reads of ${sha.slice(0, 12)} to the Atlarix review.`);

  let answers = [];
  let failures = 0;
  let reads = 0;
  while (Date.now() - startedAt < HARD_CAP_MS) {
    let r;
    try {
      r = await post(`${api}/review/runner/next`, secret, { job_id: jobId, answers });
    } catch (e) {
      if (++failures >= 3) {
        console.log(`::warning::Lost contact with Atlarix (${e.message}); it finishes the review without this runner.`);
        return 0;
      }
      await new Promise((res) => setTimeout(res, 2_000 * failures));
      continue;
    }
    failures = 0;
    if (r.status !== 200) {
      console.log(`Atlarix ended the review session (${r.status} ${r.json.error ?? ""}).`);
      return 0;
    }
    answers = [];
    if (r.json.done) {
      console.log(`Review finished on Atlarix's side; ${reads} reads served.`);
      return 0;
    }
    for (const req of Array.isArray(r.json.requests) ? r.json.requests : []) {
      if (typeof req?.id !== "number") continue;
      answers.push(answerRead(req, sha, workspace));
      reads++;
    }
  }
  console.log(`Stopping at the ${HARD_CAP_MS / 60_000}-minute cap; Atlarix finishes the review without this runner.`);
  return 0;
}

/** The dispatch event, or null. */
export function readEvent() {
  try {
    return JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
  } catch {
    return null;
  }
}
