# GitHub Action: await-remote-run

[![GitHub Workflow Status](https://img.shields.io/github/actions/workflow/status/codex-/await-remote-run/test.yml?style=flat-square)](https://github.com/Codex-/await-remote-run/actions/workflows/test.yml) [![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg?style=flat-square)](https://github.com/prettier/prettier) [![codecov](https://img.shields.io/codecov/c/github/Codex-/await-remote-run?style=flat-square)](https://codecov.io/gh/Codex-/await-remote-run) [![GitHub Marketplace](https://img.shields.io/badge/Marketplace-await–remote–run-blue.svg?colorA=24292e&colorB=0366d6&style=flat-square&longCache=true&logo=data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA4AAAAOCAYAAAAfSC3RAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAM6wAADOsB5dZE0gAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAERSURBVCiRhZG/SsMxFEZPfsVJ61jbxaF0cRQRcRJ9hlYn30IHN/+9iquDCOIsblIrOjqKgy5aKoJQj4O3EEtbPwhJbr6Te28CmdSKeqzeqr0YbfVIrTBKakvtOl5dtTkK+v4HfA9PEyBFCY9AGVgCBLaBp1jPAyfAJ/AAdIEG0dNAiyP7+K1qIfMdonZic6+WJoBJvQlvuwDqcXadUuqPA1NKAlexbRTAIMvMOCjTbMwl1LtI/6KWJ5Q6rT6Ht1MA58AX8Apcqqt5r2qhrgAXQC3CZ6i1+KMd9TRu3MvA3aH/fFPnBodb6oe6HM8+lYHrGdRXW8M9bMZtPXUji69lmf5Cmamq7quNLFZXD9Rq7v0Bpc1o/tp0fisAAAAASUVORK5CYII=)](https://github.com/marketplace/actions/await-remote-run)

Await the completion of a foreign repository Workflow Run given the Run ID.

This Action exists as a workaround for the issue where you cannot await the completion of a dispatched action.

This action requires being able to get the run ID from a dispatched action, this can be achieved through another Action i've created, [return-dispatch](https://github.com/Codex-/return-dispatch).

Should a remote workflow run fail, this action will attempt to output which step failed, with a link to the workflow run itself.

An example using both of these actions is documented below.

## Usage

Once you have configured your remote repository to work as expected with the `return-dispatch` action (**including accepting and echoing back the distinct_id input in your target workflow**), include `await-remote-run` as described below.

```yaml
steps:
  - name: Dispatch an action and get the run ID
    uses: codex-/return-dispatch@v2
    id: return_dispatch
    with:
      token: ${{ github.token }}
      repo: repository-name
      owner: repository-owner
      workflow: automation-test.yml
  - name: Await Run ID ${{ steps.return_dispatch.outputs.run_id }}
    uses: Codex-/await-remote-run@v1
    with:
      token: ${{ github.token }}
      ref: target_branch # or refs/heads/target_branch
      repo: return-dispatch
      owner: codex-
      run_id: ${{ steps.return_dispatch.outputs.run_id }}
      run_timeout_seconds: 300 # Optional
      poll_interval_ms: 5000 # Optional
```

### Permissions Required

The permissions required for this action to function correctly are:

- `repo` scope
  - You may get away with simply having `repo:public_repo`
  - `repo` is definitely needed if the repository is private.
- `actions:read`

### APIs Used

For the sake of transparency please note that this action uses the following API calls:

- [Get a workflow run](https://docs.github.com/en/rest/reference/actions#get-a-workflow-run)
  - GET `/repos/{owner}/{repo}/actions/runs/{run_id}`
  - Permissions:
    - `repo`
    - `actions:read`
- [List jobs for a workflow run](https://docs.github.com/en/rest/reference/actions#list-jobs-for-a-workflow-run)
  - GET `/repos/{owner}/{repo}/actions/runs/{run_id}/jobs`
  - Permissions:
    - `repo`
    - `actions:read`

For more information please see [api.ts](./src/api.ts).

## Where does this help?

If you want to use the result of a Workflow Run from a remote repository to complete a check locally, i.e. you have automated tests on another repository and don't want the local checks to pass if the remote fails.
