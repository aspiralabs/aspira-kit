#!/bin/bash
# Launch the planner agent without keeping the caller's tool invocation open (start/status/wait),
# or step a --local plan whose model work runs in the calling Claude Code session (local).
set -euo pipefail

NAME=planner
PKG=@aspiralabs/planner
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
# Which planner runs, in this order: PLANNER_AGENT_DIR (kit development only; the report says so),
# the @aspiralabs/planner installed under the project (walking up from the working directory, then
# from this script's location), then this script's own package. $ASPIRA_KIT is never consulted.
# Sets AGENT, AGENT_SOURCE (env | installed | package), AGENT_VERSION and PROJECT.
resolve_agent() {
  local here dir
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  AGENT="" AGENT_SOURCE="" PROJECT=""
  for dir in "${PLANNER_AGENT_DIR:-}" "${SPEC_TO_PLAN_AGENT_DIR:-}"; do
    [ -n "$dir" ] || continue
    is_agent "$dir" || die "PLANNER_AGENT_DIR is not the $PKG package: $dir"
    AGENT=$(cd "$dir" && pwd -P); AGENT_SOURCE=env; break
  done
  if [ -z "$AGENT" ]; then
    for dir in "$PWD" "$here"; do
      while :; do
        if AGENT=$(installed_in "$dir"); then AGENT_SOURCE=installed; PROJECT=$dir; break 2; fi
        [ "$dir" != / ] || break
        dir=$(dirname "$dir")
      done
    done
  fi
  if [ -z "$AGENT" ] && is_agent "$here/../../.."; then AGENT=$(cd "$here/../../.." && pwd -P); AGENT_SOURCE=package; fi
  [ -n "$AGENT" ] || die "cannot find $PKG: install @aspiralabs/agents in the project (kit init), or set PLANNER_AGENT_DIR for kit development"
  [ -n "$PROJECT" ] || PROJECT=$(project_root)
  AGENT_VERSION=$(sed -nE 's/^ *"version": *"([^"]+)".*/\1/p' "$AGENT/package.json" | head -n 1)
  case $AGENT_SOURCE:$AGENT in
    env:*) echo "$NAME: PLANNER_AGENT_DIR is set: running kit source at $AGENT, not the installed $PKG" >&2 ;;
    *:*/node_modules/*) ;;
    *) echo "$NAME: running kit source at $AGENT, not the installed $PKG" >&2 ;;
  esac
}
agent_line() { printf 'agent: %s@%s (%s, %s)\n' "$PKG" "$AGENT_VERSION" "$AGENT_SOURCE" "$AGENT"; }
json_string() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
agent_json() { printf '{"name":"%s","version":"%s","path":"%s","source":"%s","installed":%s}\n' "$PKG" "$(json_string "$AGENT_VERSION")" "$(json_string "$AGENT")" "$AGENT_SOURCE" "$(case $AGENT in */node_modules/*) echo true ;; *) echo false ;; esac)"; }
# The first <ancestor of DIR>/node_modules/RELATIVE, as Node would resolve it from the agent.
find_up_module() {
  local dir=$1
  while :; do
    if [ -e "$dir/node_modules/$2" ]; then printf '%s\n' "$dir/node_modules/$2"; return; fi
    [ "$dir" != / ] || return 1
    dir=$(dirname "$dir")
  done
}
# Node for the agent's TypeScript. amaro (Node's own type stripper) is loaded as a hook so the sources
# run from node_modules too, where Node's built-in stripping refuses them. Env files, lowest priority
# first: the project's .env.local, then the agent's own .env.local and .env.development.local (kit
# development); a variable already in the shell wins over all of them. Sets NODE_ARGS.
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
agent_node() {  # agent_node SCRIPT ARG...: run an agent script with node, from the agent directory
  local script=$1; shift
  node_args
  (cd "$AGENT" && exec node "${NODE_ARGS[@]}" "$AGENT/$script" "$@")
}
eve_bin() { find_up_module "$AGENT" eve/bin/eve.js || die "eve is not installed beside $AGENT; reinstall @aspiralabs/agents"; }
absolute_file() {
  [ -f "$1" ] || die "no such file: $1"
  echo "$(cd "$(dirname "$1")" && pwd -P)/$(basename "$1")"
}
cmd_start() {
  local spec="" guidelines="" repo="" out=""
  while [ $# -gt 0 ]; do
    case $1 in
      --guidelines) [ $# -ge 2 ] || die "--guidelines needs a path"; guidelines=$2; shift 2 ;;
      --repo) [ $# -ge 2 ] || die "--repo needs a path"; repo=$2; shift 2 ;;
      --output) [ $# -ge 2 ] || die "--output needs a path"; out=$2; shift 2 ;;
      -*) die "unknown option: $1" ;;
      *) [ -z "$spec" ] || die "one spec at a time"; spec=${1#@}; shift ;;
    esac
  done
  [ -n "$spec" ] || die "usage: planner.sh start <spec.md> [--guidelines FILE] [--repo DIR] [--output DIR]"
  spec=$(absolute_file "$spec")
  [ -z "$guidelines" ] || guidelines=$(absolute_file "$guidelines")
  repo=$(git -C "${repo:-$PWD}" rev-parse --show-toplevel) || die "run inside a Git repo or pass --repo"
  local feature_dir
  feature_dir="$(dirname "$spec")"
  if [ "$(basename "$feature_dir")" = spec.reviewed ]; then feature_dir="$(dirname "$feature_dir")"; fi
  out=${out:-"$feature_dir/plan.review"}
  [[ $out = /* ]] || out="$PWD/$out"
  local run prompt eve=""
  resolve_agent
  node_args
  command -v node >/dev/null || die "node is not installed"
  command -v screen >/dev/null || die "screen is not installed"
  [ -e "$PROJECT/.env.local" ] || [ -e "$AGENT/.env.local" ] || [ -n "${AI_GATEWAY_API_KEY:-}" ] || die "missing $PROJECT/.env.local (or the agent's .env.local) or AI_GATEWAY_API_KEY"
  [ -n "$guidelines" ] || eve=$(eve_bin)
  run=$(mktemp -d "${TMPDIR:-/tmp}/planner.XXXXXX")
  prompt="Plan implementation of the business spec at $spec against the local repository $repo. Write results directly to $out. Use load-knowledge for the required guidelines, then call create-plan once. Report status, plan.reviewed.md, run-analysis.md and trace/checks.md paths."
  printf '%s\n' "$out" > "$run/output"
  printf '%s\n' "${NODE_ARGS[@]}" > "$run/node-args"
  agent_json > "$run/agent.json"
  agent_line > "$run/agent"
  date +%s > "$run/started"
  cat > "$run/run.sh" <<'RUNNER'
#!/bin/bash
NODE_ARGS=()
while IFS= read -r line; do NODE_ARGS+=("$line"); done < "$RUN/node-args"
cd "$AGENT" || exit 1
if [ -n "$GUIDELINES" ]; then
  node "${NODE_ARGS[@]}" "$AGENT/scripts/plan.ts" "$SPEC" "$REPO" "$GUIDELINES" "$OUTPUT" > "$RUN/log" 2>&1
else
  node "${NODE_ARGS[@]}" "$EVE" invoke "$PROMPT" > "$RUN/log" 2>&1
fi
code=$?
printf '%s\n' "$code" > "$RUN/exit"
# The trace records which agent package ran.
[ ! -d "$OUTPUT/trace" ] || cp "$RUN/agent.json" "$OUTPUT/trace/agent-version.json"
RUNNER
  chmod +x "$run/run.sh"
  AGENT="$AGENT" EVE="$eve" SPEC="$spec" REPO="$repo" GUIDELINES="$guidelines" OUTPUT="$out" PROMPT="$prompt" RUN="$run" screen -dmS "planner-$(basename "$run")" "$run/run.sh"
  printf 'started\nrun: %s\nspec: %s\nrepo: %s\noutput: %s\n' "$run" "$spec" "$repo" "$out"
  agent_line
}
# One synchronous step of a --local plan: no model calls here, so no screen, gateway key or wait.
# The driver prints the next stage as JSON (knowledge, research or planning) or the exported plan.
cmd_local() {
  local spec="" guidelines="" repo="" out="" finish=""
  while [ $# -gt 0 ]; do
    case $1 in
      --guidelines) [ $# -ge 2 ] || die "--guidelines needs a path"; guidelines=$2; shift 2 ;;
      --repo) [ $# -ge 2 ] || die "--repo needs a path"; repo=$2; shift 2 ;;
      --output) [ $# -ge 2 ] || die "--output needs a path"; out=$2; shift 2 ;;
      --finish) finish=--finish; shift ;;
      -*) die "unknown option: $1" ;;
      *) [ -z "$spec" ] || die "one spec at a time"; spec=${1#@}; shift ;;
    esac
  done
  [ -n "$spec" ] || die "usage: planner.sh local <spec.md> [--guidelines FILE] [--repo DIR] [--output DIR] [--finish]"
  spec=$(absolute_file "$spec")
  [ -z "$guidelines" ] || guidelines=$(absolute_file "$guidelines")
  repo=$(git -C "${repo:-$PWD}" rev-parse --show-toplevel) || die "run inside a Git repo or pass --repo"
  local feature_dir
  feature_dir="$(dirname "$spec")"
  if [ "$(basename "$feature_dir")" = spec.reviewed ]; then feature_dir="$(dirname "$feature_dir")"; fi
  out=${out:-"$feature_dir/plan.review"}
  [[ $out = /* ]] || out="$PWD/$out"
  command -v node >/dev/null || die "node is not installed"
  local args=("$spec" "$repo" --output "$out")
  [ -z "$guidelines" ] || args+=(--guidelines "$guidelines")
  [ -z "$finish" ] || args+=("$finish")
  resolve_agent
  agent_node scripts/local.ts "${args[@]}"
}
cmd_status() {
  local run=${1:?usage: planner.sh status RUN} elapsed
  [ -f "$run/started" ] || die "not a run directory: $run"
  elapsed=$(( $(date +%s) - $(cat "$run/started") ))
  if [ ! -f "$run/exit" ]; then
    printf 'running (%ss)\nlog: %s/log\n' "$elapsed" "$run"
    [ ! -f "$run/log" ] || tail -n 3 "$run/log"
    return
  fi
  printf 'finished (%ss), exit %s\noutput: %s\n' "$elapsed" "$(cat "$run/exit")" "$(cat "$run/output")"
  [ ! -f "$run/agent" ] || cat "$run/agent"
  tail -n 40 "$run/log"
  printf 'Output paths (if this run exported):\nChecks: %s/trace/checks.md\nRun analysis: %s/run-analysis.md\nPlan: %s/plan.reviewed.md\n' "$(cat "$run/output")" "$(cat "$run/output")" "$(cat "$run/output")"
}
cmd_wait() {
  local run=${1:?usage: planner.sh wait RUN [--max SECONDS]} max=30 deadline
  if [ "${2:-}" = --max ]; then max=${3:?}; fi
  [[ $max =~ ^[0-9]+$ ]] && [ "$max" -ge 1 ] && [ "$max" -le 60 ] || die "--max must be 1..60 seconds"
  [ -f "$run/started" ] || die "not a run directory: $run"
  deadline=$(( $(date +%s) + max ))
  while [ ! -f "$run/exit" ] && [ "$(date +%s)" -lt "$deadline" ]; do sleep 1; done
  cmd_status "$run"
}
case ${1:-} in
  start) shift; cmd_start "$@" ;;
  status) shift; cmd_status "$@" ;;
  wait|watch) shift; cmd_wait "$@" ;;
  local) shift; cmd_local "$@" ;;
  *) die "usage: planner.sh start SPEC [--guidelines FILE] [--repo DIR] [--output DIR] | status RUN | wait RUN [--max SECONDS] | local SPEC [--guidelines FILE] [--repo DIR] [--output DIR] [--finish]" ;;
esac
