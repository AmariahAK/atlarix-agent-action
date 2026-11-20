// The decisions run.mjs makes, kept pure so they are tested (lib.test.mjs):
// how the CLI is invoked for a run, and what environment the agent gets.
//
// The agent's shell commands inherit the CLI's environment, so nothing that
// grants access may be in it: not the Core token (it goes in a file the CLI
// reads and deletes), not the action's inputs, not the runner's OIDC request
// credentials.

import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The CLI's arguments: Atlarix Core with the job's model and token. The token
 * is a FILE path, never a value on the command line.
 */
export function cliArgs({ claim, cliVersion, workspace, promptFile, outputFile, tokenFile }) {
  const common = ["--workspace", workspace, "--prompt-file", promptFile, "--output-file", outputFile];
  // A question only reads: the CLI's ask mode has no tool that edits or runs commands.
  if (claim.mode === "ask") common.push("--mode", "ask");
  const model = ["--provider-id", "compass", "--model", claim.tier, "--core-token-file", tokenFile];
  return [
    "-y",
    `atlarix@${cliVersion}`,
    ...common,
    ...model,
    // Inside the workflow's 45 minutes, leaving time to push and report.
    "--timeout",
    String(38 * 60 * 1000),
  ];
}

/** What this runner can do, sent with the claim: Atlarix refuses a job it can't run. */
export const SUPPORTS = ["continue", "ask"];

/**
 * How the run ends, from what the claim asked for and what happened:
 *   answer  a question: report the answer (or the failure); never push
 *   none    a task that changed nothing
 *   push    a task with changes: push the branch, then open a PR, or — on a
 *           follow-up turn — add to the PR the thread already has
 */
export function outcome({ claim, agentExit, changed }) {
  if (claim.mode === "ask") return { kind: "answer", ok: agentExit === 0 };
  if (!changed) return { kind: "none", ok: agentExit === 0 };
  return { kind: "push", force: !claim.continue_pr, openPr: !claim.continue_pr };
}

/**
 * The agent's environment: the runner's, minus anything that grants access.
 * `extra` is what this run adds (the proxy URL for a paid run, the data dir).
 */
export function childEnv(parent, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(parent)) {
    if (k.startsWith("INPUT_")) continue;
    env[k] = v;
  }
  // The runner's OIDC request credentials let any process mint an identity
  // token for this job. The agent's commands have no business doing that.
  env.ACTIONS_ID_TOKEN_REQUEST_URL = "";
  env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "";
  return { ...env, ...extra };
}

// ─── progress: what the agent is doing, from its trajectory file ─────────────
//
// The CLI streams one JSON line per event (--trajectory-file). The runner turns
// tool calls into short steps ("Edited src/login.ts") and follows the plan
// tool's checklist, and posts both to Atlarix every few seconds for the Slack
// card. Only names and paths leave the runner, never file contents or output.

const short = (s, n = 80) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** A tool call as one short line, or null for calls not worth a line. */
export function stepText(toolName, args = {}) {
  const a = args && typeof args === "object" ? args : {};
  const target = a.path ?? a.file_path ?? a.filePath ?? a.target_file ?? a.file;
  switch (toolName) {
    case "read_file":
      return target ? `Read ${short(target)}` : "Read a file";
    case "edit_file":
    case "write_file":
    case "search_replace":
    case "apply_patch":
      return target ? `Edited ${short(target)}` : "Edited files";
    case "delete_file":
      return target ? `Deleted ${short(target)}` : "Deleted a file";
    case "run_command":
    case "bash":
      return a.command ? `Ran \`${short(a.command, 70)}\`` : "Ran a command";
    case "grep":
    case "glob":
    case "search":
      return a.pattern || a.query ? `Searched for ${short(a.pattern ?? a.query, 60)}` : "Searched the code";
    case "web_search":
      return a.query ? `Searched the web: ${short(a.query, 60)}` : "Searched the web";
    case "read_url":
      return a.url ? `Read ${short(a.url, 70)}` : "Read a web page";
    case "view_image":
      return target ? `Looked at ${short(target)}` : "Looked at an image";
    case "plan":
      return null;
    default:
      return toolName ? short(toolName.replace(/_/g, " "), 40) : null;
  }
}

const MARK = { " ": "pending", x: "completed", X: "completed", "~": "in_progress", "!": "pending" };

/** The checklist in a plan's markdown: `- [ ] step`, `[x]` done, `[~]` in progress. */
export function parsePlan(markdown) {
  const out = [];
  for (const line of String(markdown ?? "").split("\n")) {
    const m = /^\s*(?:[-*]|\d+[.)])\s*\[([ xX~!])\]\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ text: short(m[2].replace(/\*\*|`/g, ""), 200), status: MARK[m[1]] ?? "pending" });
  }
  return out;
}

const STATE = { in_progress: "in_progress", done: "completed", todo: "pending", blocked: "pending", external: "completed" };

/** Follows the run: steps from tool calls, the plan from the `plan` tool. */
export class ProgressTracker {
  constructor() {
    this.steps = [];
    this.plan = [];
    this.byCall = new Map();
    this.version = 0;
  }

  /** One trajectory line (already parsed). */
  add(ev) {
    if (ev?.type === "error" && typeof ev.message === "string") this.lastError = ev.message;
    if (!ev || ev.type !== "tool_use") return;
    const args = ev.args && typeof ev.args === "object" ? ev.args : {};
    if (ev.toolName === "plan") {
      if (ev.status !== "done" && ev.status !== "success" && ev.status !== "completed") return;
      this.applyPlan(args);
      return;
    }
    const text = stepText(ev.toolName, args);
    if (!text) return;
    const status = ev.status === "running" ? "running" : ev.status === "error" ? "failed" : "done";
    const known = ev.toolCallId ? this.byCall.get(ev.toolCallId) : undefined;
    if (known) known.status = status;
    else {
      const step = { text, status };
      this.steps.push(step);
      if (ev.toolCallId) this.byCall.set(ev.toolCallId, step);
      if (this.steps.length > 40) this.steps.splice(0, this.steps.length - 40);
    }
    this.version++;
  }

  applyPlan(args) {
    if (args.operation === "write" && typeof args.content === "string") {
      const parsed = parsePlan(args.content);
      if (parsed.length) this.plan = parsed;
    } else if (args.operation === "update_step") {
      const want = STATE[args.state];
      if (!want) return;
      const i =
        typeof args.step_text === "string" && args.step_text.trim()
          ? this.plan.findIndex((p) => p.text.toLowerCase().includes(args.step_text.trim().toLowerCase()))
          : Number.isInteger(args.step_index)
            ? args.step_index
            : -1;
      if (this.plan[i]) this.plan[i] = { ...this.plan[i], status: want };
    } else if (args.operation === "append_step" && typeof args.step_text === "string" && args.step_text.trim()) {
      this.plan.push({ text: short(args.step_text, 200), status: "pending" });
    } else return;
    this.version++;
  }

  /** What /cloud/progress gets: the last few steps and the plan. */
  report() {
    return { steps: this.steps.slice(-12), plan: this.plan.slice(0, 30) };
  }
}

// ─── why a run failed, in words the person in Slack can act on ───────────────

/**
 * `stderrTail` is the end of the CLI's stderr; `started` whether the agent got
 * as far as running (a run_start line in the trajectory).
 */
export function failureReason({ exitCode, stderrTail, started, timedOut, trajectoryError }) {
  // The turn's own error, from the trajectory, says it best; stderr is the fallback.
  const tail = trajectoryError ? `${String(stderrTail ?? "")}\n{"error":${JSON.stringify(String(trajectoryError))}}` : String(stderrTail ?? "");
  if (timedOut || /timed out|timeout after|ETIMEDOUT.*turn/i.test(tail)) {
    return "The agent ran out of time before finishing.";
  }
  if (!started && /npm (ERR|error)|ERR_|could not determine executable|E404|ENOTFOUND registry|EAI_AGAIN/i.test(tail)) {
    return "The Atlarix CLI couldn't be installed on the runner (npm). Re-run the workflow; if it keeps failing, check the runner's network.";
  }
  if (/insufficient|balance|payment required|\b402\b|out of credit|credit/i.test(tail)) {
    return "The model refused the run: the Atlarix balance ran out. Add credit at https://atlarix.dev/account.";
  }
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid api key/i.test(tail)) {
    return "The model provider refused the run's credentials.";
  }
  // The CLI prints the turn's own error as JSON ("the run ended on an error");
  // that, not the "completed=false" line after it, is the reason.
  const reported = [...tail.matchAll(/"error":"((?:[^"\\]|\\.)*)"/g)].pop()?.[1];
  const last =
    (reported ? reported.replace(/\\"/g, '"') : null) ??
    tail
      .trim()
      .split("\n")
      .filter((l) => l.trim() && !/^\[atlarix-headless\] (completed=|the run ended on an error)/.test(l.trim()))
      .pop() ??
    "";
  return last
    ? `The agent stopped with an error (exit ${exitCode}): ${short(last.replace(/\[atlarix-headless\]\s*/g, ""), 200)}`
    : `The agent stopped with an error (exit ${exitCode}).`;
}

// ─── relics: what the run made to share, in the pull request or left out ────
//
// The CLI saves a relic as plain files in relics/<slug>/ and records the
// folders it made in .atlarix/relics.json (older CLIs: .atlarix/relics/<slug>/).
// By default they go in the pull request; the `relics: exclude` input leaves
// them out. Only recorded folders are touched, so a relics/ folder of the
// repository's own is never moved.

/** Files over this size are left out of the commit and named in the summary. */
export const RELIC_MAX_BYTES = 25 * 1024 * 1024;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RECORD = ".atlarix/relics.json";

/** The `relics` input: only "exclude" leaves them out. */
export function relicsMode(value) {
  return String(value ?? "").trim().toLowerCase() === "exclude" ? "exclude" : "include";
}

const lines = (s) => String(s ?? "").split("\0").filter(Boolean);

/**
 * Sort the relics this run made or changed into the commit or out of it.
 * `git(args)` runs git in `workspace` and returns its stdout.
 */
export function settleRelics({ workspace, mode, git, maxBytes = RELIC_MAX_BYTES }) {
  const atHead = (p) => git(["ls-tree", "-r", "--name-only", "HEAD", "--", p]) !== "";
  const restore = (p) => {
    if (atHead(p)) git(["checkout", "HEAD", "--", p]);
    git(["clean", "-fdq", "--", p]);
  };
  const changed = (paths) => [
    ...new Set([
      ...lines(git(["ls-files", "-z", "--others", "--exclude-standard", "--", ...paths])),
      ...lines(git(["diff", "-z", "--name-only", "HEAD", "--", ...paths])),
    ]),
  ];

  let recorded = {};
  try {
    const r = JSON.parse(readFileSync(join(workspace, RECORD), "utf8"));
    if (r && typeof r.relics === "object" && r.relics) recorded = r.relics;
  } catch {
    /* no record, or not ours to read */
  }

  const touched = changed(["relics", ".atlarix/relics", RECORD]);
  const folders = new Map();
  for (const p of touched) {
    const m = /^(relics|\.atlarix\/relics)\/([^/]+)\//.exec(p);
    if (!m || !SLUG.test(m[2])) continue;
    const old = m[1] !== "relics";
    if (!old && !Object.hasOwn(recorded, m[2])) continue;
    const dir = `${m[1]}/${m[2]}/`;
    if (!folders.has(dir)) folders.set(dir, { dir, slug: m[2], old, files: [] });
    folders.get(dir).files.push(p);
  }

  const out = { included: [], excluded: [], skipped: [] };
  for (const f of folders.values()) {
    const given = !f.old && typeof recorded[f.slug]?.title === "string" ? recorded[f.slug].title : "";
    let page = "";
    try {
      page = readFileSync(join(workspace, f.dir, "index.html"), "utf8").slice(0, 64 * 1024);
    } catch {
      /* not a page */
    }
    const title = (given.replace(/\s+/g, " ").trim() || relicTitle(page, f.slug)).slice(0, 120);
    if (mode === "exclude") {
      restore(f.dir);
      out.excluded.push({ dir: f.dir, title });
      continue;
    }
    for (const p of f.files) {
      let size = 0;
      try {
        size = statSync(join(workspace, p)).size;
      } catch {
        continue;
      }
      if (size <= maxBytes) continue;
      if (atHead(p)) git(["checkout", "HEAD", "--", p]);
      else rmSync(join(workspace, p), { force: true });
      out.skipped.push(p);
    }
    out.included.push({ dir: f.dir, title });
  }

  // The record is Atlarix's bookkeeping: only in the commit if the repository already keeps it.
  if (touched.includes(RECORD)) {
    if (!atHead(RECORD)) rmSync(join(workspace, RECORD), { force: true });
    else if (mode === "exclude") git(["checkout", "HEAD", "--", RECORD]);
  }
  return out;
}

const plain = (s) => String(s).replace(/[`*_[\]<>|\\\r\n]+/g, " ").replace(/\s+/g, " ").trim();
const where = (r) => `${plain(r.title)} (\`${r.dir}\`)`;

/** Wording pending the owner's approval. The summary note, and the opt-out hint for the pull request. */
export function relicNote({ included, excluded, skipped }) {
  const parts = [];
  if (included.length) parts.push(`Relics in this pull request: ${included.map(where).join(", ")}.`);
  if (excluded.length) parts.push(`Relics made and left out of this pull request (\`relics: exclude\`): ${excluded.map(where).join(", ")}.`);
  if (skipped.length) parts.push(`Left out, over 25 MB: ${skipped.map((p) => `\`${p}\``).join(", ")}.`);
  return {
    summary: parts.join("\n"),
    hint: included.length ? "Don't want relics in pull requests? Set `relics: exclude` on the action." : "",
  };
}

/** A relic's title: its index.html <title>, else the folder name. */
export function relicTitle(indexHtml, slug) {
  const m = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(String(indexHtml ?? ""));
  return (m ? m[1] : slug).replace(/\s+/g, " ").trim() || slug;
}
