# CodeQuill Attest Action

This GitHub Action automates the CodeQuill attestation process, triggered by external release events via GitHub Issues. 

## Features

- Installs the CodeQuill CLI automatically.
- Handles `release_anchored` and `release_approved` events via Issue payloads.
- Verified by HMAC-SHA256 signature for security.
- Executes `codequill attest` for approved releases in a non-interactive CI environment.
- Waits for the attestation transaction to complete on-chain.

## Usage

### Prerequisites

1. Enable CI integration for your repository in the CodeQuill app to obtain a `CODEQUILL_TOKEN`.
2. Generate or obtain a shared HMAC secret for your repository to verify incoming events.
3. Add these to your GitHub repository secrets as `CODEQUILL_TOKEN` and `CODEQUILL_HMAC_SECRET`.

### Example Workflow

Create a workflow file (e.g., `.github/workflows/codequill-attest.yml`) to catch release events:

```yaml
name: CodeQuill Attestation

on:
  issues:
    types: [opened, labeled]

jobs:
  handle_release:
    # Optional: basic filtering at the job level
    if: github.event.issue.user.type == 'Bot' && contains(github.event.issue.labels.*.name, 'CodeQuill Release')
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: CodeQuill Attestation
        id: codequill # Required to access outputs
        uses: codequill-claim/actions-attest@v1
        with:
          token: ${{ secrets.CODEQUILL_TOKEN }}
          hmac_secret: ${{ secrets.CODEQUILL_HMAC_SECRET }}
          github_id: ${{ github.repository_id }}
          build_path: "./dist"

      - name: Build and Deploy
        if: steps.codequill.outputs.event_type == 'release_anchored'
        run: |
          npm install
          npm run build
          # ... deploy your app ...
```

### Issue Payload Model

The bot should create an issue with the label `CodeQuill Release`. The body must be a JSON object with the following structure:

```json
{
  "payload": "{\"event\": \"release_approved\", \"release_id\": \"CQ-123\"}",
  "signature": "..."
}
```

- `payload`: A JSON string containing the event data.
- `signature`: HMAC-SHA256 hash of the `payload` string using the shared `CODEQUILL_HMAC_SECRET`.

#### Payload Fields

| Field | Description |
|-------|-------------|
| `event` | Either `release_anchored` or `release_approved`. |
| `release_id` | The CodeQuill release ID. |

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `token` | CodeQuill repo-scoped bearer token. | Yes | |
| `github_id` | GitHub repository numeric ID. | Yes | github.repository_id |
| `hmac_secret` | Shared secret for HMAC verification of the issue payload. | No* | |
| `build_path` | Path to the build artifact to attest. | No | "" |
| `release_id` | CodeQuill release ID to attest against. (Can be provided via payload). | No | "" |
| `event_type` | Override event type. If empty, detected from payload. | No | "" |
| `api_base_url` | Override CodeQuill API base URL. | No | "" |
| `cli_version` | npm version for codequill CLI. Empty = latest. | No | "" |
| `working_directory` | Working directory where CodeQuill runs. | No | . |
| `extra_args` | Extra args appended to commands (quotes supported). | No | "" |

## Outputs

| Output | Description |
|--------|-------------|
| `event_type` | The detected event type (e.g., `release_anchored`, `release_approved`). |
| `release_id` | The CodeQuill release ID. |

## How it works

1. **Event Detection**: The action checks if the event is a GitHub `issue` event.
2. **Security Checks**: 
   - Verifies the issue was created by a `Bot`.
   - Verifies the issue has the `CodeQuill Release` label.
   - If `hmac_secret` is provided, verifies the `signature` in the JSON body against the `payload`.
3. **Anchored Event**: If the event is `release_anchored`, the action logs the event and finishes.
4. **Approved Event**: If the event is `release_approved`:
   - It installs the `codequill` CLI from npm.
   - It runs `codequill attest <build_path> <release_id>`.
   - It waits for the transaction to be finalized on-chain.
