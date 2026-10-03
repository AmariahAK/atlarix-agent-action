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
