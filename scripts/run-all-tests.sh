#!/usr/bin/env bash
# Runs the tests of all four components: this simply calls scripts/run-all-tests.sh in the workspace root (two folders up).
exec bash "$(cd "$(dirname "$0")/../.." && pwd)/scripts/run-all-tests.sh" "$@"
