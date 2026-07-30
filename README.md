# GitHub Action: await-remote-run

[![GitHub Workflow Status](https://img.shields.io/github/actions/workflow/status/codex-/await-remote-run/test.yml?style=flat-square)](https://github.com/Codex-/await-remote-run/actions/workflows/test.yml) [![codecov](https://img.shields.io/codecov/c/github/Codex-/await-remote-run?style=flat-square)](https://codecov.io/gh/Codex-/await-remote-run) [![GitHub Marketplace](https://img.shields.io/badge/Marketplace-await–remote–run-blue.svg?colorA=24292e&colorB=0366d6&style=flat-square&longCache=true&logo=data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA4AAAAOCAYAAAAfSC3RAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAM6wAADOsB5dZE0gAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAERSURBVCiRhZG/SsMxFEZPfsVJ61jbxaF0cRQRcRJ9hlYn30IHN/+9iquDCOIsblIrOjqKgy5aKoJQj4O3EEtbPwhJbr6Te28CmdSKeqzeqr0YbfVIrTBKakvtOl5dtTkK+v4HfA9PEyBFCY9AGVgCBLaBp1jPAyfAJ/AAdIEG0dNAiyP7+K1qIfMdonZic6+WJoBJvQlvuwDqcXadUuqPA1NKAlexbRTAIMvMOCjTbMwl1LtI/6KWJ5Q6rT6Ht1MA58AX8Apcqqt5r2qhrgAXQC3CZ6i1+KMd9TRu3MvA3aH/fFPnBodb6oe6HM8+lYHrGdRXW8M9bMZtPXUji69lmf5Cmamq7quNLFZXD9Rq7v0Bpc1o/tp0fisAAAAASUVORK5CYII=)](https://github.com/marketplace/actions/await-remote-run)

Await the completion of a foreign repository Workflow Run given the Run ID.

This Action exists as a workaround for the issue where you cannot await the completion of a dispatched action.

This action requires being able to get the run ID from a dispatched action, see [Getting the Run ID](#getting-the-run-id).

Should a remote workflow run fail, this action will attempt to output which step failed, with a link to the workflow run itself.

## Getting the Run ID

Dispatching a run and identifying the run it created are separate problems. Either of these solves the latter:

| Source                                                         | Yields                                                    |
| -------------------------------------------------------------- | --------------------------------------------------------- |
| `gh workflow run`                                              | The run URL on stdout, the ID being its last path segment |
| [`return-dispatch`](https://github.com/Codex-/return-dispatch) | `run_id` and `run_url` step outputs                       |

Taking the ID from the `gh` CLI (>=2.87.0) looks like this:

```yaml
- name: Dispatch an action and get the run ID
  id: dispatch
  env:
    GH_TOKEN: ${{ secrets.TOKEN }}
  run: |
    run_url=$(gh workflow run automation-test.yml --repo repository-owner/repository-name --ref target_branch)
    if [ -z "$run_url" ]; then
      echo "Dispatch returned no run details"
      exit 1
    fi
    echo "run_id=${run_url##*/}" >> "$GITHUB_OUTPUT"
```

## Usage

With the run ID in hand, include `await-remote-run` as described below.

```yaml
steps:
  - name: Dispatch an action and get the run ID
    uses: codex-/return-dispatch@v4
    id: return_dispatch
    with:
      token: ${{ secrets.TOKEN }} # Note this is NOT GITHUB_TOKEN but a PAT
      ref: target_branch # or refs/heads/target_branch
      repo: repository-name
      owner: repository-owner
      workflow: automation-test.yml
  - name: Await Run ID ${{ steps.return_dispatch.outputs.run_id }}
    uses: Codex-/await-remote-run@v2
    with:
      token: ${{ github.token }}
      repo: repository-name
      owner: repository-owner
      run_id: ${{ steps.return_dispatch.outputs.run_id }}
      run_timeout_seconds: 300 # Optional
      cancel_timeout_seconds: 240 # Optional
      poll_interval_ms: 5000 # Optional
```

### Cancelling the remote run

Giving up on a remote run leaves it running, which is a problem if your workflow tears down something that run depends on, such as a test environment.

Set `cancel_timeout_seconds` to request cancellation once that much time has elapsed. It must be less than `run_timeout_seconds`, the difference being how long this action keeps polling to observe the resulting `cancelled` conclusion. Cancellation is asynchronous, so the remote run may take some time to wind down.

```yaml
- name: Await Run ID ${{ steps.return_dispatch.outputs.run_id }}
  uses: Codex-/await-remote-run@v2
  with:
    token: ${{ secrets.TOKEN }} # Cancelling is a write, so this cannot be GITHUB_TOKEN
    repo: repository-name
    owner: repository-owner
    run_id: ${{ steps.return_dispatch.outputs.run_id }}
    run_timeout_seconds: 300
    cancel_timeout_seconds: 240
```

## Token

Awaiting a run only reads it, so `GITHUB_TOKEN` is enough for a public remote repository. A private one needs a Personal Access Token (PAT), as `GITHUB_TOKEN` can only access the repository containing the workflow.

Cancelling a run is a write, and `GITHUB_TOKEN` cannot be granted `Actions` write on another repository, so `cancel_timeout_seconds` always needs a PAT.

### Permissions Required

One of the following, depending on the token type:

- Fine-grained PAT, GitHub App, or `GITHUB_TOKEN`: `Actions` repository permission, **read**
  - **write** is additionally required when using `cancel_timeout_seconds`
- Classic PAT or OAuth token: `repo` scope
  - `repo:public_repo` may be enough for a public repository

### APIs Used

For the sake of transparency please note that this action uses the following API calls:

- [Get a workflow run](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run)
  - GET `/repos/{owner}/{repo}/actions/runs/{run_id}`
  - `Actions`: read
- [List jobs for a workflow run](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run)
  - GET `/repos/{owner}/{repo}/actions/runs/{run_id}/jobs`
  - `Actions`: read
- [Cancel a workflow run](https://docs.github.com/en/rest/actions/workflow-runs#cancel-a-workflow-run), only if using `cancel_timeout_seconds`
  - POST `/repos/{owner}/{repo}/actions/runs/{run_id}/cancel`
  - `Actions`: write

For more information please see [api.ts](./src/api.ts).

## Where does this help?

If you want to use the result of a Workflow Run from a remote repository to complete a check locally, i.e. you have automated tests on another repository and don't want the local checks to pass if the remote fails.
