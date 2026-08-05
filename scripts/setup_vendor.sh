#!/usr/bin/env bash
# setup_vendor.sh — finalise the esp-web-tools fork submodule.
#
# Idempotent. Detects what needs doing:
#   1. If the local fork at $FORK_DIR has no `origin` remote, prints
#      instructions to create mullender/esp-web-tools on GitHub and
#      re-run.
#   2. If the submodule already exists in installer/vendor/esp-web-tools/,
#      just runs `git submodule update --init --recursive`.
#   3. Otherwise, adds the submodule.
#
# Usage:
#   scripts/setup_vendor.sh
#
# Environment:
#   FORK_DIR    default: ~/Development/esp-web-tools-fork
#   FORK_URL    default: https://github.com/mullender/esp-web-tools.git
#   FORK_BRANCH default: homekey-post-install-hook

set -euo pipefail

FORK_DIR="${FORK_DIR:-$HOME/Development/esp-web-tools-fork}"
FORK_URL="${FORK_URL:-https://github.com/mullender/esp-web-tools.git}"
FORK_BRANCH="${FORK_BRANCH:-homekey-post-install-hook}"
SUBMODULE_PATH="installer/vendor/esp-web-tools"

cd "$(git rev-parse --show-toplevel)"

# Case: submodule already present.
if [[ -f .gitmodules ]] && grep -q "${SUBMODULE_PATH}" .gitmodules 2>/dev/null; then
  echo "Submodule already present at ${SUBMODULE_PATH}."
  git submodule update --init --recursive "${SUBMODULE_PATH}"
  exit 0
fi

# Case: local fork exists but is not pushed to GitHub.
if [[ -d "${FORK_DIR}/.git" ]]; then
  if ! (cd "${FORK_DIR}" && git remote get-url origin >/dev/null 2>&1); then
    cat <<EOF
The local fork at ${FORK_DIR} has no 'origin' remote.

Create the empty repo on GitHub, then push:

  1. Visit https://github.com/new
     - name: esp-web-tools
     - owner: mullender
     - description: Fork of esphome/esp-web-tools with post-install callback
     - public
     - no README, no .gitignore, no license (the fork already has them)

  2. From this shell:
     cd ${FORK_DIR}
     git remote add origin ${FORK_URL}
     git push -u origin main ${FORK_BRANCH}

  3. Re-run this script.
EOF
    exit 2
  fi
  # Optional: verify the branch is pushed.
  if ! (cd "${FORK_DIR}" && git ls-remote --heads origin "${FORK_BRANCH}" | grep -q .); then
    echo "Branch ${FORK_BRANCH} exists locally but not on origin."
    echo "Push it: (cd ${FORK_DIR} && git push origin ${FORK_BRANCH})"
    exit 2
  fi
fi

echo "Adding submodule at ${SUBMODULE_PATH}"
git submodule add -b "${FORK_BRANCH}" "${FORK_URL}" "${SUBMODULE_PATH}"

echo "Recording submodule and building for the first time"
(cd "${SUBMODULE_PATH}" && npm ci --loglevel=error --no-progress && ./script/build)

echo
echo "Done. Commit with:"
echo "  git add .gitmodules ${SUBMODULE_PATH}"
echo "  git commit -m 'vendor: add esp-web-tools fork submodule'"
