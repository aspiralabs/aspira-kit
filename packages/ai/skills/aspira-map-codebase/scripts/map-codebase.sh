#!/bin/bash
# The /aspira-map-codebase launcher: runs `kit map-codebase` from the global @aspiralabs/ai with the
# arguments it was given, relays its output and exits with its code. It has no rules of its own and,
# unlike the other launchers, needs no aspira.json: a map is built for any git repository.
set -euo pipefail

die() { echo "aspira-map-codebase: $*" >&2; exit 1; }
# Only the global kit (pnpm add -g @aspiralabs/ai) on PATH runs; a project's own node_modules copy is never used.
KIT=$(command -v kit) || die "cannot find kit: install @aspiralabs/ai globally (pnpm add -g @aspiralabs/ai) and run kit update"
exec "$KIT" map-codebase "$@"
