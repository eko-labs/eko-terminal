#!/bin/sh
# Link EKO's pre-push check into this clone's .git/hooks. Run once per clone.
# It does not change core.hooksPath, so any global hooks you use keep running (a global dispatcher that hands off to
# .git/hooks, or git's default .git/hooks, both pick this up).
set -eu
root=$(git rev-parse --show-toplevel)
hooks=$(git -C "$root" rev-parse --git-common-dir)/hooks
mkdir -p "$hooks"
chmod +x "$root/scripts/hooks/pre-push"
ln -sf "$root/scripts/hooks/pre-push" "$hooks/pre-push"
echo "Installed: $hooks/pre-push -> scripts/hooks/pre-push"
custom=$(git -C "$root" config --get core.hooksPath || true)
[ -n "$custom" ] && echo "Note: core.hooksPath is $custom; make sure the hooks there hand off to .git/hooks, or the check will not run."
exit 0
