# Atlarix cloud agent — GitHub Action

The [Atlarix cloud agent](https://atlarix.dev/cloud-agent) is an AI coding agent that works on your
repository while your computer is off. This action is the part that runs in GitHub Actions: it runs
the [Atlarix CLI](https://atlarix.dev/cli) on the task, on paid Atlarix models or free on your own
API key.

It runs work you ask Atlarix for (from Slack or [atlarix.dev/cloud](https://atlarix.dev/cloud)) **in your own repository's GitHub Actions**, then opens a pull request. Nothing is merged until the person who asked approves it.

You don't add this by hand. The setup page on atlarix.dev opens a pull request that adds `.github/workflows/atlarix.yml`:

```yaml
on:
  repository_dispatch:
    types: [atlarix-task]
permissions:
  id-token: write
  contents: read
jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0, persist-credentials: false }
      - uses: AmariahAK/atlarix-agent-action@v1
        with:
          job-id: ${{ github.event.client_payload.job_id }}
```

## What it does, and what it can reach

1. **Claims the job.** The runner asks GitHub for an OIDC token (audience `atlarix-cloud`) and presents it to Atlarix. That token is the only credential: nothing secret is stored in your repository. Atlarix checks it names this repository and this workflow file, then returns the task and, for a run on an Atlarix model, a **Core token for this one job** (it stops working when the job ends, and within an hour at most).
2. **Runs the agent.** `npx atlarix` works on the checkout, with the Core token in a file it reads and deletes. The token is never in the environment, and the runner's OIDC credentials are removed from the agent's environment, so commands the agent runs can reach neither.
3. **Pushes and opens the PR.** Only after the agent has exited, the action gets a push token scoped to **this repository** (`contents` + `pull_requests`), pushes `atlarix/<job>` and opens the pull request. The workflow's own `GITHUB_TOKEN` stays read-only.

Compute is your Actions minutes (free and unlimited on public repositories).

## Models

You pick the model when you start a run (atlarix.dev, or `[core-2]` / `[byok]` in Slack):

- **Atlarix Auto** (default) or **a Core model**: billed to the Atlarix account that asked, from its balance (Pro or credit).
- **Your own API key**: free on Atlarix's side. In this repository's Settings → Secrets and variables → Actions, add:
  - the secret `ATLARIX_PROVIDER_KEY`: your API key;
  - the variables `ATLARIX_PROVIDER` (e.g. `anthropic`, `openai`, `openrouter`) and `ATLARIX_MODEL` (that provider's model id).

  The key goes to Atlarix in a file it deletes before starting. It is never in the environment, never on the command line, and never in a settings file the agent could read. A run on your own key gets no Atlarix token at all.

## Preparing the environment

If your tests need more than the checkout (dependencies, a database), add `.atlarix/cloud-setup.sh`. It runs before the agent, with network access.

## Inputs

| Input | Default | |
| --- | --- | --- |
| `job-id` | — | From the dispatch payload. Required. |
| `api-url` | `https://cloud.atlarix.dev` | Only for a staging deployment. |
| `cli-version` | `latest` | The `atlarix` npm version to run. |
| `provider-key` | — | Your own key, for own-key runs: `${{ secrets.ATLARIX_PROVIDER_KEY }}`. Ignored on runs using Atlarix models. |
| `provider` | — | Your key's provider id, for own-key runs. |
| `model` | — | That provider's model id, for own-key runs. |
