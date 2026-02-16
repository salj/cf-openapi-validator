#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Update all configured openapi-source/* branches.

Usage:
  scripts/update-configured-branches.sh [--allow-force-push]

Options:
  --allow-force-push   Permit force-push behavior for rewritten source branches.
USAGE
}

DEFAULT_BRANCH="${OPENAPI_DEFAULT_BRANCH:-${GITHUB_REF_NAME:-}}"
SOURCE_BRANCH_PREFIX="openapi-source/"
CONFIG_PATH=".openapi/source.json"
ARTIFACTS_PATH="artifacts"
ALLOW_FORCE_PUSH="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
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

if [[ -z "$DEFAULT_BRANCH" ]]; then
  ORIGIN_HEAD_REF="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  if [[ -n "$ORIGIN_HEAD_REF" ]]; then
    DEFAULT_BRANCH="${ORIGIN_HEAD_REF#origin/}"
  fi
fi

if [[ -z "$DEFAULT_BRANCH" ]]; then
  REMOTE_HEAD_LINE="$(git ls-remote --symref origin HEAD 2>/dev/null | awk '/^ref:/ {print $2; exit}' || true)"
  if [[ "$REMOTE_HEAD_LINE" == refs/heads/* ]]; then
    DEFAULT_BRANCH="${REMOTE_HEAD_LINE#refs/heads/}"
  fi
fi

if [[ -z "$DEFAULT_BRANCH" ]]; then
  if command -v gh >/dev/null 2>&1; then
    DEFAULT_BRANCH="$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name' 2>/dev/null || true)"
  fi
fi

if [[ -z "$DEFAULT_BRANCH" ]]; then
  CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [[ "$CURRENT_BRANCH" != "HEAD" && -n "$CURRENT_BRANCH" ]]; then
    DEFAULT_BRANCH="$CURRENT_BRANCH"
  fi
fi

if [[ -z "$DEFAULT_BRANCH" ]]; then
  echo "Unable to determine default branch." >&2
  exit 1
fi

ORIGINAL_REF="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || git rev-parse --verify HEAD)"
restore_original_ref() {
  if [[ -n "${ORIGINAL_REF:-}" ]]; then
    git checkout -q "$ORIGINAL_REF" >/dev/null 2>&1 || true
  fi
}

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required" >&2
  exit 1
fi

apply_filtered_commit() {
  local commit_sha="$1"
  local patch_file="$2"

  if ! git diff-tree -p --binary "${commit_sha}^!" -- "$CONFIG_PATH" "$ARTIFACTS_PATH" >"$patch_file"; then
    return 1
  fi

  if [[ ! -s "$patch_file" ]]; then
    return 0
  fi

  if ! git apply --index --3way "$patch_file" >/dev/null 2>&1; then
    if ! git apply --index "$patch_file" >/dev/null 2>&1; then
      echo "Failed to apply filtered patch for commit ${commit_sha}" >&2
      return 1
    fi
  fi

  if git diff --cached --quiet; then
    return 0
  fi

  local author_name author_email author_date committer_date message_file
  author_name="$(git show -s --format=%an "$commit_sha")"
  author_email="$(git show -s --format=%ae "$commit_sha")"
  author_date="$(git show -s --format=%aI "$commit_sha")"
  committer_date="$(git show -s --format=%cI "$commit_sha")"
  message_file="$(mktemp)"
  git show -s --format=%B "$commit_sha" >"$message_file"

  GIT_AUTHOR_NAME="$author_name" \
  GIT_AUTHOR_EMAIL="$author_email" \
  GIT_AUTHOR_DATE="$author_date" \
  GIT_COMMITTER_DATE="$committer_date" \
  git commit --quiet --no-verify -F "$message_file"

  rm -f "$message_file"
  return 0
}

replay_branch_history() {
  local branch="$1"
  local patch_file="$2"
  local base_ref source_ref
  base_ref="origin/$DEFAULT_BRANCH"
  source_ref="origin/$branch"

  local commits=()
  mapfile -t commits < <(git rev-list --reverse "${base_ref}..${source_ref}" -- "$CONFIG_PATH" "$ARTIFACTS_PATH")

  if [[ ${#commits[@]} -eq 0 ]]; then
    return 0
  fi

  echo "Replaying ${#commits[@]} artifact/config commits from ${branch}"
  for commit_sha in "${commits[@]}"; do
    if ! apply_filtered_commit "$commit_sha" "$patch_file"; then
      echo "Failed replaying commit ${commit_sha} for ${branch}" >&2
      return 1
    fi
  done
}

git fetch --prune origin "+refs/heads/*:refs/remotes/origin/*" || true

mapfile -t BRANCHES < <(git for-each-ref --format='%(refname:strip=3)' "refs/remotes/origin")

if [[ ${#BRANCHES[@]} -eq 0 ]]; then
  echo "No remote branches found on origin. No-op."
  exit 0
fi

tmp_config="$(mktemp)"
tmp_patch="$(mktemp)"
cleanup() {
  rm -f "$tmp_config"
  rm -f "$tmp_patch"
  restore_original_ref
}
trap cleanup EXIT

CONFIGURED_BRANCHES=()
for BRANCH in "${BRANCHES[@]}"; do
  if [[ "$BRANCH" == "HEAD" ]]; then
    continue
  fi

  if [[ "$BRANCH" != ${SOURCE_BRANCH_PREFIX}* ]]; then
    continue
  fi

  if [[ "$BRANCH" == "$DEFAULT_BRANCH" ]]; then
    continue
  fi

  if git show "origin/${BRANCH}:.openapi/source.json" >"$tmp_config" 2>/dev/null; then
    CONFIGURED_BRANCHES+=("$BRANCH")
  fi
done

if [[ ${#CONFIGURED_BRANCHES[@]} -eq 0 ]]; then
  echo "No ${SOURCE_BRANCH_PREFIX}* branches with .openapi/source.json found. No-op."
  exit 0
fi

for BRANCH in "${CONFIGURED_BRANCHES[@]}"; do
  git show "origin/${BRANCH}:${CONFIG_PATH}" >"$tmp_config"

  echo "Processing ${BRANCH}"
  git checkout -q -B "$BRANCH" "origin/$DEFAULT_BRANCH"
  replay_branch_history "$BRANCH" "$tmp_patch"
  mkdir -p .openapi
  cp "$tmp_config" "$CONFIG_PATH"

  npm run openapi:artifacts -- --sync-tags --config-file "$CONFIG_PATH"

  git add -f "$CONFIG_PATH" "$ARTIFACTS_PATH"

  if git diff --cached --quiet -- "$CONFIG_PATH" "$ARTIFACTS_PATH"; then
    echo "No artifact changes for ${BRANCH}"
    continue
  fi

  git commit --quiet --no-verify -m "chore(openapi): refresh artifacts for ${BRANCH}"
  if [[ "$ALLOW_FORCE_PUSH" == "true" ]]; then
    if ! git push --force-with-lease origin "HEAD:${BRANCH}"; then
      echo "Initial push failed for ${BRANCH} (likely stale lease). Refreshing and retrying once..."
      git fetch origin "$BRANCH" || true
      if ! git push --force-with-lease origin "HEAD:${BRANCH}"; then
        echo "Lease retry failed for ${BRANCH}. Falling back to --force."
        git push --force origin "HEAD:${BRANCH}"
      fi
    fi
  else
    if ! git push origin "HEAD:${BRANCH}"; then
      echo "Push rejected for ${BRANCH} without force. Re-run with --allow-force-push to permit rewritten branch updates." >&2
      exit 1
    fi
  fi
done
