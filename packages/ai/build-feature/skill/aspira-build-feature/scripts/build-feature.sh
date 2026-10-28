#!/bin/bash
# Launch /aspira-build-feature. This skill only steps the official build-feature driver: the stages
# it prints are performed by this Claude Code session and its subagents (SKILL.md). By default
# every step runs its skill in this session; with --cloud every step runs its skill with --cloud (the
# step's cloud agent, which the step skill starts and waits on). --local is accepted and means the default. build-feature itself has no
# start/status/wait: the run is always this session, and the driver makes no model call.
set -euo pipefail

NAME=build-feature
die() { echo "$NAME: $*" >&2; exit 1; }
# The agent folder of @aspiralabs/ai: named $NAME, with skill/ and agent/, src/ or scripts/, under a
# package.json that names @aspiralabs/ai (recognised by path).
is_agent() {
  [ "$(basename "$1")" = "$NAME" ] && [ -d "$1/skill" ] && { [ -d "$1/agent" ] || [ -d "$1/src" ] || [ -d "$1/scripts" ]; } \
    && grep -qs '"name": "@aspiralabs/ai"' "$1/../package.json"
}
# The global kit: on PATH, else in pnpm's global bin, which Claude Code's Bash PATH can lack (KIT-76):
# $PNPM_HOME, ~/Library/pnpm (macOS), ~/.local/share/pnpm (Linux), each with or without bin/, then `pnpm bin -g`.
find_kit() {
  local base dir
  command -v kit 2>/dev/null && return
  for base in "${PNPM_HOME:-}" "$HOME/Library/pnpm" "${XDG_DATA_HOME:-$HOME/.local/share}/pnpm" "$(command -v pnpm >/dev/null 2>&1 && pnpm bin -g 2>/dev/null)"; do
    [ -n "$base" ] || continue
    for dir in "$base" "$base/bin"; do
      if [ -x "$dir/kit" ]; then printf '%s\n' "$dir/kit"; return; fi
    done
  done
  return 1
}
# The agent folder of the global @aspiralabs/ai (pnpm add -g), from the global kit, which prints its own directory,
# else from `pnpm root -g`. `kit package-dir` also rewrites the global skills when they are behind the kit (self-healing).
global_install() {
  local pkg="" kit root
  if kit=$(find_kit); then pkg=$("$kit" package-dir 2>/dev/null) || pkg=""
  elif command -v pnpm >/dev/null 2>&1 && root=$(pnpm root -g 2>/dev/null); then pkg=$root/@aspiralabs/ai
  fi
  [ -n "$pkg" ] || return 1
  if is_agent "$pkg/$NAME"; then (cd "$pkg/$NAME" && pwd -P); return; fi
  return 1
}
# The project the agent serves, found from the working directory only (or the --repo the caller names),
# never from this script's own location (the skills live in ~/.claude, not in a project). A directory
# with no aspira.json at or above it is not an Aspira project. In a multi-app repository
# (`kit init --app`) the project is the app aspira.json names; otherwise the nearest package.json above
# the working directory, else the git root, else the working directory.
project_root() {
  local start dir app_dir
  for start in "$PWD" "${REPO:-}"; do
    [ -n "$start" ] || continue
    dir=$start
    while :; do
      if [ -f "$dir/aspira.json" ]; then
        app_dir=$(sed -nE 's/.*"app"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$dir/aspira.json" | head -n 1)
        if [ -n "$app_dir" ] && [ -d "$dir/$app_dir" ]; then (cd "$dir/$app_dir" && pwd -P); return 0; fi
        dir=$start
        while :; do
          if [ -f "$dir/package.json" ]; then printf '%s\n' "$dir"; return 0; fi
          [ "$dir" != / ] || break
          dir=$(dirname "$dir")
        done
        git -C "$start" rev-parse --show-toplevel 2>/dev/null || printf '%s\n' "$start"
        return 0
      fi
      [ "$dir" != / ] || break
      dir=$(dirname "$dir")
    done
  done
  die "no Aspira project here (no aspira.json at or above $PWD); run kit init --board <Feature Board URL> in the main checkout (aspira.json is git-ignored, so a fresh clone has none)"
}
# Which NAME runs, in this order: BUILD_FEATURE_AGENT_DIR (kit development only; the report says so), then
# the global @aspiralabs/ai (`kit package-dir`, the kit found by find_kit). A project's own node_modules copy and $ASPIRA_KIT are never consulted.
# Sets AGENT, AGENT_SOURCE (env | global), AGENT_VERSION and PROJECT.
resolve_agent() {
  local here dir pinned="" current
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  # The skill's pin, read before the kit runs: `kit package-dir` rewrites a stale global skill.
  [ ! -f "$here/../.kit-version" ] || pinned=$(tr -d '[:space:]' < "$here/../.kit-version")
  AGENT="" AGENT_SOURCE="" PROJECT=""
  for dir in "${BUILD_FEATURE_AGENT_DIR:-}"; do
    [ -n "$dir" ] || continue
    is_agent "$dir" || die "BUILD_FEATURE_AGENT_DIR is not the $NAME folder of @aspiralabs/ai: $dir"
    AGENT=$(cd "$dir" && pwd -P); AGENT_SOURCE=env; break
  done
  if [ -z "$AGENT" ] && AGENT=$(global_install); then AGENT_SOURCE=global; fi
  [ -n "$AGENT" ] || die "cannot find $NAME: install @aspiralabs/ai globally (pnpm add -g @aspiralabs/ai) and run kit update; if it is installed, add pnpm's global bin to PATH (export PATH=\"\$HOME/Library/pnpm:\$PATH\" in your shell profile) and restart Claude Code; or set BUILD_FEATURE_AGENT_DIR for kit development"
  PROJECT=$(project_root)
  AGENT_VERSION=$(sed -nE 's/^ *"version": *"([^"]+)".*/\1/p' "$AGENT/../package.json" | head -n 1)
  case $AGENT_SOURCE:$AGENT in
    env:*) echo "$NAME: BUILD_FEATURE_AGENT_DIR is set: running kit source at $AGENT, not the installed @aspiralabs/ai" >&2 ;;
    *:*/node_modules/*) ;;
    *) echo "$NAME: running kit source at $AGENT, not the installed @aspiralabs/ai" >&2 ;;
  esac
  # The skill is pinned to the @aspiralabs/ai version it was copied from (.kit-version). A global skill
  # whose pin differs from the kit is blocked before anything starts: when kit package-dir just rewrote
  # it, say so and stop, so the next command runs the updated skill; when it is still behind, point at
  # kit update. Running from source (env) only warns, since kit development runs ahead of any pin.
  if [ -n "$pinned" ] && [ -n "$AGENT_VERSION" ] && [ "$pinned" != "$AGENT_VERSION" ]; then
    if [ "$AGENT_SOURCE" = global ]; then
      current=$(tr -d '[:space:]' < "$here/../.kit-version" 2>/dev/null || true)
      if [ "$current" = "$AGENT_VERSION" ]; then
        echo "$NAME: skills were updated to $AGENT_VERSION; run the command again" >&2
        exit 1
      fi
      die "blocked: this skill is pinned to @aspiralabs/ai $pinned but the global @aspiralabs/ai is $AGENT_VERSION; run kit update"
    else
      echo "$NAME: mismatch: this skill is pinned to @aspiralabs/ai $pinned but the kit is $AGENT_VERSION; continuing from $AGENT_SOURCE" >&2
    fi
  fi
}
agent_line() { printf 'agent: %s@%s (%s, %s)\n' "$NAME" "$AGENT_VERSION" "$AGENT_SOURCE" "$AGENT"; }
# The first <ancestor of DIR>/node_modules/RELATIVE, as Node would resolve it from the agent.
find_up_module() {
  local dir=$1
  while :; do
    if [ -e "$dir/node_modules/$2" ]; then printf '%s\n' "$dir/node_modules/$2"; return; fi
    [ "$dir" != / ] || return 1
    dir=$(dirname "$dir")
  done
}
# Node for the agent's TypeScript. amaro (Node's own type stripper) is loaded as a hook so the
# sources run from node_modules too, where Node's built-in stripping refuses them. Env files, lowest
# priority first: the project's .env.local, then the agent's own .env.local and
# .env.development.local (kit development); a variable already in the shell wins over all of them.
# Sets NODE_ARGS.
node_args() {
  local loader
  NODE_ARGS=()
  if loader=$(find_up_module "$AGENT" amaro/dist/register-strip.mjs); then NODE_ARGS+=(--import "$loader")
  else case $AGENT in */node_modules/*) die "amaro is not installed beside $AGENT; reinstall @aspiralabs/ai" ;; esac
  fi
  NODE_ARGS+=(--experimental-strip-types)
  local file env_root=$PROJECT croot
  # Inside a client layout the client root's .env.local replaces the repo's, for every key (KIT-68).
  if croot=$(client_root); then env_root=$croot; fi
  for file in "$env_root/.env.local" "$AGENT/.env.local" "$AGENT/.env.development.local"; do [ ! -f "$file" ] || NODE_ARGS+=("--env-file=$file"); done
}
# The client root: the folder of the nearest aspira.json at or above the project when that file has `repos`.
client_root() {
  local dir=$PROJECT
  while :; do
    if [ -f "$dir/aspira.json" ]; then
      grep -q '"repos"' "$dir/aspira.json" || return 1
      printf '%s\n' "$dir"; return 0
    fi
    [ "$dir" != / ] || return 1
    dir=$(dirname "$dir")
  done
}
usage() { die "usage: build-feature.sh local <ID> [--cloud] [--autonomous] [--run RUNID] [--force-run] [--finish]. By default every step runs its skill in this session; with --cloud every step runs its skill's cloud agent. --autonomous (not with --cloud) skips the human gates: the groomer takes every question as recommended and confirms itself."; }
cmd_local() {
  [ $# -ge 1 ] || usage
  local id=$1; shift
  local repo
  resolve_agent
  # A client root is not a git repository: the driver is handed the client root itself (KIT-68).
  repo=$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null) || repo=$(client_root) || die "run inside a Git repo"
  node_args
  agent_line >&2
  (cd "$AGENT" && exec node "${NODE_ARGS[@]}" "$AGENT/scripts/local.ts" "$id" --repo "$repo" "$@")
}
case ${1:-} in
  local) shift; cmd_local "$@" ;;
  start|status|wait|watch) die "/aspira-build-feature has no $1: the run is always this session. Use local <ID> (steps in this session) or local <ID> --cloud (each step's cloud agent)." ;;
  *) usage ;;
esac
