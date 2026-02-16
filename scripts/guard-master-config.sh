#!/usr/bin/env bash
set -euo pipefail

TARGET_BRANCH="master"
SOURCE_BRANCH_PREFIX="openapi-source/"
CONFIG_PATH=".openapi/source.json"
ARTIFACTS_PATH="artifacts"

current_branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
if [[ "$current_branch" == "$TARGET_BRANCH" ]]; then
  if git diff --cached --name-only -- "$CONFIG_PATH" | grep -q "^${CONFIG_PATH}$"; then
    echo "Blocking commit: ${CONFIG_PATH} cannot be committed on ${TARGET_BRANCH}." >&2
    echo "Use a dedicated source branch for config/artifact updates." >&2
    exit 1
  fi

  if git diff --cached --name-only -- "$ARTIFACTS_PATH" | grep -q "^${ARTIFACTS_PATH}/"; then
    echo "Blocking commit: ${ARTIFACTS_PATH}/ cannot be committed on ${TARGET_BRANCH}." >&2
    echo "Use a dedicated source branch for config/artifact updates." >&2
    exit 1
  fi
fi

if [[ "$current_branch" == ${SOURCE_BRANCH_PREFIX}* ]]; then
  disallowed=0
  while IFS= read -r staged_path; do
    [[ -z "$staged_path" ]] && continue
    if [[ "$staged_path" == "$CONFIG_PATH" || "$staged_path" == ${ARTIFACTS_PATH}/* ]]; then
      continue
    fi
    echo "Blocking commit on ${current_branch}: only ${CONFIG_PATH} and ${ARTIFACTS_PATH}/ are allowed." >&2
    echo "Disallowed path: ${staged_path}" >&2
    disallowed=1
  done < <(git diff --cached --name-only)

  if [[ "$disallowed" -eq 1 ]]; then
    exit 1
  fi
fi
