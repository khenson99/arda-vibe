#!/usr/bin/env bash
set -euo pipefail

if ! repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "Error: run this script from inside a git repository."
  exit 1
fi

cd "$repo_root"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean. Commit or stash changes first."
  git status --short
  exit 1
fi

git fetch origin --prune
git checkout main
git pull --ff-only origin main

local_sha="$(git rev-parse main)"
remote_sha="$(git rev-parse origin/main)"

if [[ "$local_sha" != "$remote_sha" ]]; then
  echo "Error: local main does not match origin/main after sync."
  exit 1
fi

echo "Synced to GitHub main at $(git rev-parse --short main)."
