#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Create or update a source branch with .openapi/source.json configuration.

Usage:
  scripts/configure-source-branch.sh [--branch name] [--preset generic|immich] [--allow-force-push]

This script:
1) bases the branch on the current default branch tip
2) writes .openapi/source.json
3) pushes the branch (force only with --allow-force-push)
USAGE
}

SOURCE_BRANCH_PREFIX="openapi-source/"
BRANCH_NAME=""
PRESET="generic"
SOURCE_REPO=""
SCHEMA_PATH=""
NON_INTERACTIVE="false"
AUTO_NON_INTERACTIVE="false"
PRESET_SET="false"
ALLOW_FORCE_PUSH="false"

prompt_with_default() {
  local prompt="$1"
  local default_value="$2"
  local output_var="$3"
  local value=""
  read -r -p "$prompt [$default_value]: " value
  if [[ -z "$value" ]]; then
    value="$default_value"
  fi
  printf -v "$output_var" '%s' "$value"
}

list_presets() {
  cat <<'PRESETS'
Available presets:
- generic
- immich
PRESETS
}

apply_preset() {
  case "$1" in
    generic)
      SOURCE_REPO_DEFAULT="owner/repo"
      SCHEMA_PATH_DEFAULT="path/to/openapi.json"
      ;;
    immich)
      SOURCE_REPO_DEFAULT="immich-app/immich"
      SCHEMA_PATH_DEFAULT="open-api/immich-openapi-specs.json"
      ;;
    *)
      echo "Unknown preset: $1" >&2
      exit 1
      ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch)
      BRANCH_NAME="${2:-}"
      AUTO_NON_INTERACTIVE="true"
      shift 2
      ;;
    --preset)
      PRESET="${2:-}"
      PRESET_SET="true"
      AUTO_NON_INTERACTIVE="true"
      shift 2
      ;;
    --source-repo)
      SOURCE_REPO="${2:-}"
      AUTO_NON_INTERACTIVE="true"
      shift 2
      ;;
    --schema-path)
      SCHEMA_PATH="${2:-}"
      AUTO_NON_INTERACTIVE="true"
      shift 2
      ;;
    --non-interactive)
      NON_INTERACTIVE="true"
      shift
      ;;
    --allow-force-push)
      ALLOW_FORCE_PUSH="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if ! command -v git >/dev/null 2>&1; then
  echo "git is required" >&2
  exit 1
fi

git_path_exists() {
  local marker="$1"
  local marker_path
  marker_path="$(git rev-parse --git-path "$marker" 2>/dev/null || true)"
  [[ -n "$marker_path" && -e "$marker_path" ]]
}

assert_no_git_operation_in_progress() {
  local marker=""
  for marker in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG sequencer; do
    if git_path_exists "$marker"; then
      echo "Refusing to run: git operation in progress (${marker}). Finish or abort it first." >&2
      exit 1
    fi
  done
}

assert_no_git_operation_in_progress

CURRENT_BRANCH="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
if [[ -z "$CURRENT_BRANCH" || "$CURRENT_BRANCH" == "HEAD" ]]; then
  echo "Must be on a local branch (not detached HEAD)." >&2
  exit 1
fi
BASE_REF="$(git rev-parse --verify HEAD)"

echo "Configure source branch"
list_presets
if [[ "$NON_INTERACTIVE" != "true" && "$PRESET_SET" != "true" ]]; then
  prompt_with_default "Preset" "$PRESET" PRESET
fi
apply_preset "$PRESET"

if [[ "$AUTO_NON_INTERACTIVE" == "true" ]]; then
  NON_INTERACTIVE="true"
fi

if [[ -z "$BRANCH_NAME" ]]; then
  if [[ "$NON_INTERACTIVE" == "true" ]]; then
    BRANCH_NAME="${SOURCE_BRANCH_PREFIX}${PRESET}"
  else
    prompt_with_default "Branch name" "${SOURCE_BRANCH_PREFIX}${PRESET}" BRANCH_NAME
  fi
fi

# Enforce prefix and collapse accidental duplicate prefixes.
if [[ "$BRANCH_NAME" != ${SOURCE_BRANCH_PREFIX}* ]]; then
  BRANCH_NAME="${SOURCE_BRANCH_PREFIX}${BRANCH_NAME}"
fi
while [[ "$BRANCH_NAME" == ${SOURCE_BRANCH_PREFIX}${SOURCE_BRANCH_PREFIX}* ]]; do
  BRANCH_NAME="${SOURCE_BRANCH_PREFIX}${BRANCH_NAME#${SOURCE_BRANCH_PREFIX}${SOURCE_BRANCH_PREFIX}}"
done

echo "Branch name: ${BRANCH_NAME}"
if [[ "$BRANCH_NAME" == "$CURRENT_BRANCH" ]]; then
  echo "Refusing to configure current branch '${CURRENT_BRANCH}'. Use a dedicated source branch." >&2
  exit 1
fi
if [[ -z "$SOURCE_REPO" && "$NON_INTERACTIVE" == "true" ]]; then
  SOURCE_REPO="$SOURCE_REPO_DEFAULT"
fi
if [[ -z "$SOURCE_REPO" ]]; then
  if [[ "$NON_INTERACTIVE" == "true" ]]; then
    echo "Missing --source-repo in non-interactive mode." >&2
    exit 1
  fi
  prompt_with_default "sourceRepo" "$SOURCE_REPO_DEFAULT" SOURCE_REPO
fi
if [[ -z "$SCHEMA_PATH" && "$NON_INTERACTIVE" == "true" ]]; then
  SCHEMA_PATH="$SCHEMA_PATH_DEFAULT"
fi
if [[ -z "$SCHEMA_PATH" ]]; then
  if [[ "$NON_INTERACTIVE" == "true" ]]; then
    echo "Missing --schema-path in non-interactive mode." >&2
    exit 1
  fi
  prompt_with_default "Schema file path in source repo" "$SCHEMA_PATH_DEFAULT" SCHEMA_PATH
fi
SCHEMA_PATH="${SCHEMA_PATH#/}"


echo ""
echo "Will update branch: $BRANCH_NAME"
echo "Base branch: $CURRENT_BRANCH (${BASE_REF})"
echo "Config file: .openapi/source.json"
if [[ "$NON_INTERACTIVE" != "true" ]]; then
  read -r -p "Proceed with force-push update? (y/N): " confirm
  if [[ "${confirm,,}" != "y" && "${confirm,,}" != "yes" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

git fetch origin "$BRANCH_NAME" || true

WORKTREE_DIR="$(mktemp -d)"
cleanup() {
  git worktree remove --force "$WORKTREE_DIR" >/dev/null 2>&1 || true
  rm -rf "$WORKTREE_DIR"
}
trap cleanup EXIT

git worktree add -B "$BRANCH_NAME" "$WORKTREE_DIR" "$BASE_REF"
mkdir -p "$WORKTREE_DIR/.openapi"
SOURCE_REPO="$SOURCE_REPO" \
SCHEMA_PATH="$SCHEMA_PATH" \
WORKTREE_DIR="$WORKTREE_DIR" \
node - <<'NODE'
const fs = require('fs');
const path = `${process.env.WORKTREE_DIR}/.openapi/source.json`;
const data = {
  sourceRepo: process.env.SOURCE_REPO || '',
  schemaPath: process.env.SCHEMA_PATH || ''
};
fs.writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
NODE

git -C "$WORKTREE_DIR" add -f .openapi/source.json
if ! git -C "$WORKTREE_DIR" diff --cached --quiet -- .openapi/source.json; then
  git -C "$WORKTREE_DIR" commit --no-verify -m "chore(openapi): configure source branch ${BRANCH_NAME}"
fi

if [[ "$ALLOW_FORCE_PUSH" == "true" ]]; then
  if ! git -C "$WORKTREE_DIR" push --force-with-lease origin "HEAD:${BRANCH_NAME}"; then
    echo "Initial push failed (likely stale lease). Refreshing and retrying once..."
    git fetch origin "$BRANCH_NAME" || true
    if ! git -C "$WORKTREE_DIR" push --force-with-lease origin "HEAD:${BRANCH_NAME}"; then
      echo "Lease retry failed. Falling back to --force for ${BRANCH_NAME}."
      git -C "$WORKTREE_DIR" push --force origin "HEAD:${BRANCH_NAME}"
    fi
  fi
else
  if ! git -C "$WORKTREE_DIR" push origin "HEAD:${BRANCH_NAME}"; then
    echo "Push rejected for ${BRANCH_NAME} without force. Re-run with --allow-force-push to permit rewritten branch updates." >&2
    exit 1
  fi
fi

echo "Updated ${BRANCH_NAME}."
