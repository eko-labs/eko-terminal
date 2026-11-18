#!/bin/bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ $# -ne 0 ]]; then
  echo "Usage: scripts/ship.sh" >&2
  exit 2
fi

require_clean_tree() {
  local changes
  changes=$(git status --porcelain) || return 1
  if [[ -n $changes ]]; then
    echo "The working tree has changes. Ship requires a clean checkout of the commit to push." >&2
    return 1
  fi
}

require_clean_tree
revision=$(git rev-parse HEAD)

echo "Running local CI for $revision."
bash scripts/ci-local.sh

require_clean_tree
if [[ $(git rev-parse HEAD) != "$revision" ]]; then
  echo "HEAD changed during local CI. Run ship again for the new commit." >&2
  exit 1
fi

echo "Pushing the checked commit to the private repository's main branch."
git push origin HEAD:main

echo "Publishing the checked commit to the public repository."
node scripts/public/publish.mjs --push --ref "$revision"
