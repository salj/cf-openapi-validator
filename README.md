# OpenAPI Validator Worker

![LLM MARK OF SHAME](https://img.shields.io/badge/LLM-mark_of_shame-f00?style=plastic)
![License: WTFPL](https://img.shields.io/badge/License-WTFPL-brightgreen.svg)

Service-bound Cloudflare Worker for OpenAPI validation

## Build Model

- Validators are content-addressed shared objects in `artifacts/objects/<sha256>.mjs`.
- Each release tag has a composition manifest in `artifacts/tags/<tag>.json`.
- Generated per-version import modules are in `artifacts/versions/`.
- Runtime loader index is in `artifacts/versionLoaders.mjs`.

## Source Configuration Model

Source configuration is branch-local and file-based.

- Any `openapi-source/*` branch containing `.openapi/source.json` is treated as a source branch.
- The workflow rebuilds each source branch from default-branch tip, replays only prior `.openapi/source.json` and `artifacts/` commits (preserving original author/message/timestamps), then force-pushes that branch.
- Default branch is always excluded from source-branch updates.
- The workflow fails fast when no non-default branches contain `.openapi/source.json`.
- Automation runs on `push` to `master`, scheduled every 6 hours, and manual dispatch.

## Configure a Source Branch

Interactive setup:

```bash
scripts/configure-source-branch.sh
```

Preset setup for Immich:

```bash
scripts/configure-source-branch.sh --preset immich [--branch immich]
```

This writes `.openapi/source.json` and force-pushes the source branch.
The source branch is recreated from your currently checked-out branch `HEAD`.
Commits on `openapi-source/*` branches are restricted to `.openapi/source.json` and `artifacts/` only.
Commits that stage `.openapi/source.json` or `artifacts/` on `master` are blocked by pre-commit hook.

Expected config keys:

- `sourceRepo` (required, `owner/repo`)
- `schemaPath` (required, path to schema JSON in that repo; URL is derived as `https://raw.githubusercontent.com/<sourceRepo>/<tag>/<schemaPath>`)

## Run Updates

Local/manual run:

```bash
npm run openapi:update-branches
```

Direct single-source build (for debugging a checked-out branch):

```bash
npm run openapi:artifacts -- --sync-tags --config-file .openapi/source.json
```

## Generic Example Config

```json
{
  "sourceRepo": "owner/repo",
  "schemaPath": "path/to/openapi.json"
}
```

## Immich Example Config

```json
{
  "sourceRepo": "immich-app/immich",
  "schemaPath": "open-api/immich-openapi-specs.json"
}
```

## Version Resolution

Validation requests can target a specific release version.

- Request body field: `version`
- Or query param: `?version=vX.Y.Z`
- Or header: `x-openapi-version: vX.Y.Z`
- If omitted, latest known release is used.

## Routes

- `GET /healthz`
- `GET /versions`
- `GET /meta`
- `POST /validate-response`

Request body for validation:

```json
{
  "version": "v2.5.6",
  "path": "/api/endpoint",
  "method": "GET",
  "status": 200,
  "contentType": "application/json",
  "payload": {}
}
```
