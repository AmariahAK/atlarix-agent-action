// The decisions run.mjs makes, kept pure so they are tested (lib.test.mjs):
// how the CLI is invoked for a run, and what environment the agent gets.
//
// The agent's shell commands inherit the CLI's environment, so nothing that
// grants access may be in it: not the user's provider key, not the Core
// token (both go in files the CLI reads and deletes), not the action's inputs,
// not the runner's OIDC request credentials.

/** What is missing for an own-key run, said so the user can fix the workflow; or null. */
export function byokProblem({ key, provider, model }) {
  const missing = [];
  if (!key) missing.push("the repository secret ATLARIX_PROVIDER_KEY (your API key)");
  if (!provider) missing.push("the repository variable ATLARIX_PROVIDER (e.g. anthropic)");
  if (!model) missing.push("the repository variable ATLARIX_MODEL (that provider's model id)");
  if (missing.length) {
    return `This run is set to use your own API key, but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set. Add ${missing.length === 1 ? "it" : "them"} in Settings → Secrets and variables → Actions, or start the run on an Atlarix model instead.`;
  }
  // Which providers exist is the CLI's to say (it knows the live list and
  // refuses an unknown one), not a copy kept here.
  if (!/^[a-z0-9_-]{2,40}$/.test(provider)) return `ATLARIX_PROVIDER "${provider}" isn't a provider id (e.g. anthropic, openai, openrouter).`;
  return null;
}

/**
 * The CLI's arguments. A paid run talks to Atlarix Core with the job's token;
 * an own-key run talks straight to the user's provider with their key. Each
 * credential is a FILE path, never a value on the command line.
 */
export function cliArgs({ claim, cliVersion, workspace, promptFile, outputFile, tokenFile, keyFile, byok }) {
  const common = ["--workspace", workspace, "--prompt-file", promptFile, "--output-file", outputFile];
  const model = byok
    ? ["--provider-id", byok.provider, "--model", byok.model, "--api-key-file", keyFile]
    : ["--provider-id", "compass", "--model", claim.tier, "--core-token-file", tokenFile];
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

/** Variables never passed to the agent, whatever run this is. */
const NEVER = new Set(["ATLARIX_PROVIDER_KEY", "ATLARIX_PROVIDER", "ATLARIX_MODEL"]);

/**
 * The agent's environment: the runner's, minus anything that grants access.
 * `extra` is what this run adds (the proxy URL for a paid run, the data dir).
 */
export function childEnv(parent, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(parent)) {
    if (NEVER.has(k) || k.startsWith("INPUT_")) continue;
    env[k] = v;
  }
  // The runner's OIDC request credentials let any process mint an identity
  // token for this job. The agent's commands have no business doing that.
  env.ACTIONS_ID_TOKEN_REQUEST_URL = "";
  env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "";
  return { ...env, ...extra };
}

/**
 * What an own-key run tells Atlarix about itself when it finishes: which
 * provider and model it used, so the user's usage shows as their own key and
 * not as a lapsed customer. Never the key. Nothing for a paid run, whose model
 * Atlarix already knows (it is the job's tier).
 */
export function ownKeyReport(byok) {
  return byok ? { provider: byok.provider, model: byok.model } : {};
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

// ─── relics: pages the run made, published instead of committed ─────────────

const TEXT_EXT = new Set([".html", ".htm", ".css", ".js", ".mjs", ".json", ".svg", ".txt", ".md", ".csv", ".xml"]);

/** A relic folder's files as the relics function takes them (text, or base64 for binary). */
export function relicPayload(files) {
  return files.map(({ path, bytes }) => {
    const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
    return TEXT_EXT.has(ext)
      ? { path, content: Buffer.from(bytes).toString("utf8") }
      : { path, content: Buffer.from(bytes).toString("base64"), encoding: "base64" };
  });
}

/** A relic's title: its index.html <title>, else the folder name. */
export function relicTitle(indexHtml, slug) {
  const m = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(String(indexHtml ?? ""));
  return (m ? m[1] : slug).replace(/\s+/g, " ").trim() || slug;
}
