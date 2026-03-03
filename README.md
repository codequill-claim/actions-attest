# CodeQuill Attest Action

This GitHub Action automates the CodeQuill attestation process, typically triggered by external release events. It is designed to work seamlessly with `repository_dispatch` events.

## Features

- Installs the CodeQuill CLI automatically.
- Handles `release_anchored` and `release_approved` events.
- Executes `codequill attest` for approved releases in a non-interactive CI environment.
- Waits for the attestation transaction to complete on-chain.

## Usage

### Prerequisites

1. Enable CI integration for your repository in the CodeQuill app to obtain a `CODEQUILL_TOKEN`.
2. Add this token to your GitHub repository secrets as `CODEQUILL_TOKEN`.

### Example Workflow

Create a workflow file (e.g., `.github/workflows/codequill-attest.yml`) to catch release events:

```yaml
name: CodeQuill Attestation

on:
  repository_dispatch:
    types: [release_anchored, release_approved]

jobs:
  handle_release:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      # Example: build only when anchored
      - name: Build Application
        if: github.event.action == 'release_anchored'
        run: |
          npm install
          npm run build
          # You can deploy your app here

      # Attest when approved (the action skips if it's 'anchored')
      - name: CodeQuill Attestation
        if: github.event.action == 'release_approved'
        uses: ophelios-studio/codequill-action-attest@v1
        with:
          token: ${{ secrets.CODEQUILL_TOKEN }}
          github_id: ${{ github.repository_id }}
          build_path: "./dist"
          release_id: ${{ github.event.client_payload.release_id }}
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `token` | CodeQuill repo-scoped bearer token. | Yes | |
| `github_id` | GitHub repository numeric ID. | Yes | github.repository_id |
| `build_path` | Path to the build artifact to attest. Required for `release_approved`. | No | "" |
| `release_id` | CodeQuill release ID to attest against. Required for `release_approved`. | No | "" |
| `event_type` | Override event type. If empty, detected from `github.event.action`. | No | "" |
| `api_base_url` | Override CodeQuill API base URL. | No | "" |
| `cli_version` | npm version for codequill CLI. Empty = latest. | No | "" |
| `working_directory` | Working directory where CodeQuill runs. | No | . |
| `extra_args` | Extra args appended to commands (quotes supported). | No | "" |

## How it works

1. **Event Detection**: The action checks the `event_type` (either passed as input or from the GitHub `repository_dispatch` payload).
2. **Anchored Event**: If the event is `release_anchored`, the action logs the event and finishes. This is the signal for you to build and deploy your application.
3. **Approved Event**: If the event is `release_approved`:
   - It installs the `codequill` CLI from npm.
   - It runs `codequill attest <build_path> <release_id> --no-confirm --json --no-wait`.
   - It parses the resulting transaction hash and runs `codequill wait` to ensure the attestation is finalized on-chain.
4. **Manual Run**: If run manually or via other events, it will attempt attestation if `build_path` and `release_id` are provided.
