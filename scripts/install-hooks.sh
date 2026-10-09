#!/bin/sh
# One-time setup per clone: use the repository's .githooks folder so the secret scan runs before every commit.
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit
echo "Git hooks installed (core.hooksPath=.githooks)."
