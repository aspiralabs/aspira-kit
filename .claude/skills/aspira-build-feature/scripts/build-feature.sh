#!/bin/bash
# Launch /aspira-build-feature. This skill only steps the official build-feature driver: the stages
# it prints are performed by this Claude Code session and its subagents (SKILL.md). With --local
# every step runs its skill with --local; without it every step runs its skill's default mode (the
# step's cloud agent, which the step skill starts and waits on). build-feature itself has no
# start/status/wait: the run is always this session, and the driver makes no model call.
set -euo pipefail

NAME=build-feature
PKG=@aspiralabs/build-feature
die() { echo "$NAME: $*" >&2; exit 1; }
is_agent() { grep -qs "\"name\": \"$PKG\"" "$1/package.json"; }
# The agent under DIR/node_modules: installed directly, or beside @aspiralabs/agents (pnpm keeps a
# package's dependencies next to it, not in the project's own node_modules).
installed_in() {
  local nm=$1/node_modules/@aspiralabs sibling
  if is_agent "$nm/$NAME"; then (cd "$nm/$NAME" && pwd -P); return; fi
  if [ -d "$nm/agents" ]; then
    sibling="$(cd -P "$nm/agents" 2>/dev/null && cd .. && pwd -P)/$NAME"
    if is_agent "$sibling"; then (cd "$sibling" && pwd -P); return; fi
  fi
  return 1
}
# The project the agent serves, when it is not the one the agent is installed in: the nearest
# package.json above the working directory, else the git root, else the working directory.
project_root() {
  local dir=$PWD
  while :; do
    if [ -f "$dir/package.json" ]; then printf '%s\n' "$dir"; return; fi
    [ "$dir" != / ] || break
    dir=$(dirname "$dir")
  done
  git -C "$PWD" rev-parse --show-toplevel 2>/dev/null || printf '%s\n' "$PWD"
}
# In a multi-app repository `kit init --app` records the app in the root's aspira.json. Prints that
# app's directory from the nearest aspira.json at or above DIR (this script's location, under
# <root>/.claude/skills/), or nothing when there is none.
configured_app() {
  local dir=$1 app_dir
  while :; do
    if [ -f "$dir/aspira.json" ]; then
      app_dir=$(sed -nE 's/^[[:space:]]*"app"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$dir/aspira.json" | head -n 1)
      if [ -n "$app_dir" ] && [ -d "$dir/$app_dir" ]; then (cd "$dir/$app_dir" && pwd -P); fi
      return 0
    fi
    [ "$dir" != / ] || return 0
    dir=$(dirname "$dir")
  done
}
# Which build-feature runs, in this order: BUILD_FEATURE_AGENT_DIR (kit development only; the report
# says so), the @aspiralabs/build-feature installed under the project (the app named in the root's
# aspira.json, then walking up from the working directory, then from this script's location), then
# this script's own package. $ASPIRA_KIT is never consulted.
# Sets AGENT, AGENT_SOURCE (env | installed | package), AGENT_VERSION and PROJECT.
resolve_agent() {
  local here dir app_dir own skill_kit_version agents_version
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  AGENT="" AGENT_SOURCE="" PROJECT=""
  for dir in "${BUILD_FEATURE_AGENT_DIR:-}"; do
    [ -n "$dir" ] || continue
    is_agent "$dir" || die "BUILD_FEATURE_AGENT_DIR is not the $PKG package: $dir"
    AGENT=$(cd "$dir" && pwd -P); AGENT_SOURCE=env; break
  done
  if [ -z "$AGENT" ]; then
    app_dir=$(configured_app "$here")
    if [ -n "$app_dir" ] && AGENT=$(installed_in "$app_dir"); then AGENT_SOURCE=installed; PROJECT=$app_dir; fi
  fi
  if [ -z "$AGENT" ]; then
    # A kit checkout that installs its own agents (to run /aspira-* on itself) finds this very
    # package through its root node_modules. That is the package, not a project install, so the
    # project is still the working directory's.
    own=$( (cd "$here/../../.." 2>/dev/null && pwd -P) || true)
    for dir in "$PWD" "$here"; do
      while :; do
        if AGENT=$(installed_in "$dir"); then
          if [ "$AGENT" = "$own" ]; then AGENT_SOURCE=package; else AGENT_SOURCE=installed; PROJECT=$dir; fi
          break 2
        fi
        [ "$dir" != / ] || break
        dir=$(dirname "$dir")
      done
    done
  fi
  if [ -z "$AGENT" ] && is_agent "$here/../../.."; then AGENT=$(cd "$here/../../.." && pwd -P); AGENT_SOURCE=package; fi
  [ -n "$AGENT" ] || die "cannot find $PKG: install @aspiralabs/agents in the project (kit init), or set BUILD_FEATURE_AGENT_DIR for kit development"
  [ -n "$PROJECT" ] || PROJECT=$(project_root)
  AGENT_VERSION=$(sed -nE 's/^ *"version": *"([^"]+)".*/\1/p' "$AGENT/package.json" | head -n 1)
  case $AGENT_SOURCE:$AGENT in
    env:*) echo "$NAME: BUILD_FEATURE_AGENT_DIR is set: running kit source at $AGENT, not the installed $PKG" >&2 ;;
    *:*/node_modules/*) ;;
    *) echo "$NAME: running kit source at $AGENT, not the installed $PKG" >&2 ;;
  esac
  # kit init pins the installed skill to the @aspiralabs/agents version it was copied from
  # (.kit-version, packages/kit/src/skills.ts). An installed launcher whose pin no longer matches
  # what is installed is blocked before anything starts; running from source (env or package) only
  # warns, since kit development deliberately runs ahead of (or without) an installed pin (F8).
  if [ -f "$here/../.kit-version" ]; then
    skill_kit_version=$(tr -d '[:space:]' < "$here/../.kit-version")
    agents_version=$(sed -nE 's/^ *"version": *"([^"]+)".*/\1/p' "$PROJECT/node_modules/@aspiralabs/agents/package.json" 2>/dev/null | head -n 1)
    if [ -n "$agents_version" ] && [ "$skill_kit_version" != "$agents_version" ]; then
      if [ "$AGENT_SOURCE" = installed ]; then
        die "blocked: this skill is pinned to @aspiralabs/agents $skill_kit_version but $PROJECT has $agents_version installed; run kit init to update the skill"
      else
        echo "$NAME: mismatch: this skill is pinned to @aspiralabs/agents $skill_kit_version but $PROJECT has $agents_version installed; continuing from $AGENT_SOURCE" >&2
      fi
    fi
  fi
}
agent_line() { printf 'agent: %s@%s (%s, %s)\n' "$PKG" "$AGENT_VERSION" "$AGENT_SOURCE" "$AGENT"; }
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
  else case $AGENT in */node_modules/*) die "amaro is not installed beside $AGENT; reinstall @aspiralabs/agents" ;; esac
  fi
  NODE_ARGS+=(--experimental-strip-types)
  local file
  for file in "$PROJECT/.env.local" "$AGENT/.env.local" "$AGENT/.env.development.local"; do [ ! -f "$file" ] || NODE_ARGS+=("--env-file=$file"); done
}
usage() { die "usage: build-feature.sh local <ID> [--local] [--autonomous] [--run RUNID] [--force-run] [--finish]. With --local every step runs its skill with --local; without it every step runs its skill's cloud agent. --autonomous (with --local) skips the human gates: the groomer takes every question as recommended and confirms itself."; }
cmd_local() {
  [ $# -ge 1 ] || usage
  local id=$1; shift
  local repo
  repo=$(git -C "$PWD" rev-parse --show-toplevel) || die "run inside a Git repo"
  resolve_agent
  node_args
  agent_line >&2
  (cd "$AGENT" && exec node "${NODE_ARGS[@]}" "$AGENT/scripts/local.ts" "$id" --repo "$repo" "$@")
}
case ${1:-} in
  local) shift; cmd_local "$@" ;;
  start|status|wait|watch) die "/aspira-build-feature has no $1: the run is always this session. Use local <ID> --local (steps in this session) or local <ID> (each step's cloud agent)." ;;
  *) usage ;;
esac
