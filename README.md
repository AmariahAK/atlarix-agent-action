# Atlarix cloud agent — GitHub Action

The [Atlarix cloud agent](https://atlarix.dev/cloud-agent) is an AI coding agent that works on your
repository while your computer is off. This action is the part that runs in GitHub Actions: it runs
the [Atlarix CLI](https://atlarix.dev/cli) on the task, on Atlarix's models.

It runs work you ask Atlarix for (from Slack or [atlarix.dev/cloud](https://atlarix.dev/cloud)) **in your own repository's GitHub Actions**, then opens a pull request. Nothing is merged until the person who asked approves it.

## Get started

1. Open **[atlarix.dev/cloud](https://atlarix.dev/cloud)** and sign in.
2. Install the **Atlarix Cloud Agent** GitHub App on the repositories it may work on.
3. Press **Add workflow** next to a repository. That opens a pull request adding the workflow below; merge it.
4. Ask for work there, or DM Atlarix in Slack: `owner/repo: fix the flaky login test`.

You don't add this file by hand; the setup pull request adds `.github/workflows/atlarix.yml`:

```yaml
on:
  repository_dispatch:
    types: [atlarix-task, atlarix-review]
permissions:
  id-token: write
  contents: read
concurrency:
  group: atlarix-${{ github.event.client_payload.group || github.event.client_payload.job_id }}
  cancel-in-progress: ${{ github.event.action == 'atlarix-review' }}
jobs:
  run:
    if: github.event.action == 'atlarix-task'
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0, persist-credentials: false }
      - uses: AmariahAK/atlarix-agent-action@v1
        with:
          job-id: ${{ github.event.client_payload.job_id }}
  review:
    if: github.event.action == 'atlarix-review'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
        with: { ref: "${{ github.event.client_payload.sha }}", fetch-depth: 1, persist-credentials: false }
      - uses: AmariahAK/atlarix-agent-action@v1
        with:
          job-id: ${{ github.event.client_payload.job_id }}
```

A workflow added before reviews existed lists only `atlarix-task`; tasks work as before, and reviews keep reading through the GitHub API until you add `atlarix-review` and the `review` job.

## What it does, and what it can reach

1. **Claims the job.** The runner asks GitHub for an OIDC token (audience `atlarix-cloud`) and presents it to Atlarix. That token is the only credential: nothing secret is stored in your repository. Atlarix checks it names this repository and this workflow file, then returns the task and a **Core token for this one job** (it stops working when the job ends, and within an hour at most).
2. **Runs the agent.** `npx atlarix` works on the checkout, with the Core token in a file it reads and deletes. The token is never in the environment, and the runner's OIDC credentials are removed from the agent's environment, so commands the agent runs can reach neither.
3. **Pushes and opens the PR.** Only after the agent has exited, the action gets a push token scoped to **this repository** (`contents` + `pull_requests`), pushes `atlarix/<job>` and opens the pull request. The workflow's own `GITHUB_TOKEN` stays read-only.

**A reply in the Slack thread** is the next turn of the same task. While its pull request is open, the next run starts on that PR's branch, adds its commits without force-pushing, and the PR updates. **A question** (`ask owner/repo: …`) runs the agent read-only and posts the answer; Atlarix never gives that run a push token.

Compute is your Actions minutes (free and unlimited on public repositories).

## Pull-request reviews in your runner (opt-in)

The [Atlarix Reviewer](https://atlarix.dev) normally reads a pull request through the GitHub API. You can have it read the code from a checkout in your own runner instead: search is then complete and at the pull request's own commit, with no API quota spent. Turn it on per repository with front matter in `.atlarix.md` on the **default branch** (a pull request can't change it):

```markdown
---
review_in_actions: true
---
```

It also needs the Atlarix Cloud Agent app on the repository and the workflow above (with `atlarix-review`).

- **What runs here:** a read-only checkout of the pull request's head commit (depth 1, no credentials kept) that answers Atlarix's reads: a file, the path list, a fixed-string `git grep`. Nothing in the pull request is installed or run, and this runner gets no model token and no write token. The review itself (the model, the findings, the comment) runs on Atlarix's side and is billed exactly as before.
- **Minutes:** the runner waits while the model thinks, so a review uses your Actions minutes for about as long as it takes (typically a few minutes; capped at 15). Free on public repositories; **on private repositories this is billed to your account's Actions minutes.** It ends as soon as the review is posted.
- **Never lost:** if the runner doesn't start within 3 minutes (Actions disabled, no runner, a workflow without `atlarix-review`), or can't answer a read, the review reads through the GitHub API as usual. A newer push cancels the older review's run.

## Models

The cloud agent is a paid feature. Runs use **Atlarix Auto** (the default, and the only model from Slack) or **a Core model** you pick on atlarix.dev, billed to the Atlarix account that asked, from its balance (Pro or credit).

## Preparing the environment

If your tests need more than the checkout (dependencies, a database), add `.atlarix/cloud-setup.sh`. It runs before the agent, with network access.

## Inputs

| Input | Default | |
| --- | --- | --- |
| `job-id` | — | From the dispatch payload. Required. |
| `api-url` | `https://cloud.atlarix.dev` | Only for a staging deployment. |
| `cli-version` | `latest` | The `atlarix` npm version to run. |

## FAQ

**What does it cost?** The compute is your own GitHub Actions minutes. The model is billed per run to the Atlarix account that asked (Pro allowance first, then credit).

**Does it work on private repositories?** Yes. The workflow runs in your repository's own Actions, and the agent only reaches the repository the job is for.

**Can it merge on its own?** No. Every change comes back as a pull request, and nothing merges until the person who asked approves it (on atlarix.dev or with the Approve button in Slack).

**Which models can I use?** Atlarix Auto or a Core model. To use your own API key or a local model, run the same agent on your machine with the [Atlarix CLI](https://atlarix.dev/cli) or the [desktop app](https://atlarix.dev).

**Can I run the same agent locally?** Yes: the [Atlarix CLI](https://atlarix.dev/cli) is the same agent in your terminal (`brew install amariahak/atlarix/atlarix` or `npm install -g atlarix`), and the [desktop app](https://atlarix.dev) is free.

## License

See [LICENSE](LICENSE). Atlarix is built by [NorahLabs](https://norahlabs.com).
