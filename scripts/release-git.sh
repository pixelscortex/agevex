#!/bin/sh
# Publish a git-installable build of agevex to the `release` branch.
#
# Bun does not install a git dependency's devDependencies before its lifecycle
# scripts, so a consumer cannot build agevex on install. Instead this script
# builds `dist/` here and commits it, with `src/` and the package manifest, to a
# `release` branch. Consumers pin a commit on that branch:
#   "agevex": "github:pixelscortex/agevex#<release commit>"
#
# Usage: bun run release:git   (from a clean checkout of the commit to release)
set -eu

repo=$(git rev-parse --show-toplevel)
cd "$repo"
test -z "$(git status --porcelain)" || { echo "release:git: working tree is not clean" >&2; exit 1; }
source_sha=$(git rev-parse --short HEAD)

# Refuse to publish a build Convex would reject at deploy (scripts/check-deploy.sh).
# `build` starts from an empty dist/, so files renamed or deleted in src/ never
# linger in the published payload.
sh scripts/check-deploy.sh
bun run build

tree=$(mktemp -d)
trap 'git worktree remove --force "$tree" >/dev/null 2>&1 || true' EXIT
if git fetch -q origin release 2>/dev/null; then
  git worktree add -q -B release "$tree" origin/release
else
  git worktree add -q --detach "$tree" && (cd "$tree" && git checkout -q --orphan release && git rm -rq --cached . && git clean -fdq)
fi

# Replace the published payload wholesale so deleted files disappear too.
(cd "$tree" && find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +)
cp -R dist src package.json README.md "$tree"/
[ -f LICENSE ] && cp LICENSE "$tree"/

cd "$tree"
git add -A
if git diff --cached --quiet; then
  echo "release:git: nothing changed since the last release"
else
  git commit -qm "release: agevex built from ${source_sha}"
  git push -q origin release
  echo "release:git: published $(git rev-parse --short HEAD) (from ${source_sha})"
fi
