#!/bin/bash
# Launch the implementor agent on a GitHub repository without keeping the caller's tool invocation
# open (start/status/wait), or step a --local build whose model work runs in the calling Claude Code
# session (local).
set -euo pipefail

NAME=implementor
PKG=@aspiralabs/implementor
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
# Which implementor runs, in this order: IMPLEMENTOR_AGENT_DIR (kit development only; the report says so),
# the @aspiralabs/implementor installed under the project (walking up from the working directory, then
# from this script's location), then this script's own package. $ASPIRA_KIT is never consulted.
# Sets AGENT, AGENT_SOURCE (env | installed | package), AGENT_VERSION and PROJECT.
resolve_agent() {
  local here dir
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  AGENT="" AGENT_SOURCE="" PROJECT=""
  for dir in "${IMPLEMENTOR_AGENT_DIR:-}"; do
    [ -n "$dir" ] || continue
    is_agent "$dir" || die "IMPLEMENTOR_AGENT_DIR is not the $PKG package: $dir"
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
  [ -n "$AGENT" ] || die "cannot find $PKG: install @aspiralabs/agents in the project (kit init), or set IMPLEMENTOR_AGENT_DIR for kit development"
  [ -n "$PROJECT" ] || PROJECT=$(project_root)
  AGENT_VERSION=$(sed -nE 's/^ *"version": *"([^"]+)".*/\1/p' "$AGENT/package.json" | head -n 1)
  case $AGENT_SOURCE:$AGENT in
    env:*) echo "$NAME: IMPLEMENTOR_AGENT_DIR is set: running kit source at $AGENT, not the installed $PKG" >&2 ;;
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
absolute_path() {
  if [[ $1 = /* ]]; then printf '%s\n' "$1"; else printf '%s/%s\n' "$PWD" "$1"; fi
}
is_github() {
  [[ $1 =~ ^(https?://(www\.)?github\.com/|git@github\.com:)?[A-Za-z0-9_-][A-Za-z0-9_.-]*/[A-Za-z0-9_.-]+(\.git)?/?$ ]] && [ ! -d "$1" ]
}
SOURCE="" REPO="" REF="" PR="" LOCAL="" GUIDELINES="" PARALLEL="" SERIAL="" WORK="" FINISH=""
parse() {
  while [ $# -gt 0 ]; do
    case $1 in
      --repo) [ $# -ge 2 ] || die "--repo needs a directory or owner/name"; REPO=$2; shift 2 ;;
      --ref) [ $# -ge 2 ] || die "--ref needs a branch"; REF=$2; shift 2 ;;
      --pr) PR=1; shift ;;
      --local) LOCAL=1; shift ;;
      --guidelines) [ $# -ge 2 ] || die "--guidelines needs a file"; GUIDELINES=$(absolute_path "$2"); shift 2 ;;
      --max-parallel) [ $# -ge 2 ] || die "--max-parallel needs a number"; PARALLEL=$2; shift 2 ;;
      --serial) SERIAL=1; shift ;;
      --work) [ $# -ge 2 ] || die "--work needs a directory"; WORK=$(absolute_path "$2"); shift 2 ;;
      --finish) FINISH=1; shift ;;
      -*) die "unknown option: $1" ;;
      *) [ -z "$SOURCE" ] || die "one source at a time"; SOURCE=${1#@}; shift ;;
    esac
  done
  if [ -n "$PARALLEL" ]; then
    [[ $PARALLEL =~ ^[0-9]+$ ]] && [ "$PARALLEL" -ge 1 ] && [ "$PARALLEL" -le 16 ] || die "--max-parallel must be 1..16"
  fi
}
# owner/name of a GitHub remote URL, or nothing.
github_of() {
  local url=$1
  url=${url%.git}
  url=${url%/}
  if [[ $url =~ ^(https?://(www\.)?github\.com/|git@github\.com:|ssh://git@github\.com/)([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)$ ]]; then printf '%s\n' "${BASH_REMATCH[3]}"; fi
}
cmd_start() {
  parse "$@"
  if [ -n "$LOCAL" ]; then local_step; return; fi
  [ -n "$SOURCE" ] || die "usage: implementor.sh start <path-in-repo> [--repo owner/name | --repo DIR] [--ref BRANCH] [--pr]"
  [ -z "$GUIDELINES$PARALLEL$SERIAL$WORK$FINISH" ] || die "--guidelines, --max-parallel, --serial, --work and --finish are for --local; the agent loads its rules from Notion"
  local repo ref=$REF source=$SOURCE
  if [ -n "$REPO" ] && is_github "$REPO"; then
    repo=$REPO
    [[ $source != /* ]] || die "the source must be a path inside the repository, not an absolute local path: $source"
  else
    # A local checkout: the agent clones its GitHub origin, so the source must be committed and pushed there.
    local dir top file branch
    dir=${REPO:-$PWD}
    [ -d "$dir" ] || die "not a directory: $dir"
    top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || die "$dir is not in a git repository; pass --repo owner/name"
    top=$(cd "$top" && pwd -P)
    file=$(absolute_path "$source")
    [ -e "$file" ] || die "no such file or directory: $source"
    file=$(cd "$(dirname "$file")" && pwd -P)/$(basename "$file")
    [[ $file == "$top"/* ]] || die "$source is not inside $top"
    source=${file#"$top"/}
    repo=$(github_of "$(git -C "$top" remote get-url origin 2>/dev/null || true)")
    [ -n "$repo" ] || die "the origin of $top is not a GitHub repository; pass --repo owner/name, or use --local"
    [ -n "$(git -C "$top" ls-files -- "$source")" ] || die "$source is not committed; the agent clones $repo and cannot see it. Commit and push it, or use --local"
    [ -z "$(git -C "$top" status --porcelain -- "$source")" ] || die "$source has uncommitted changes; commit and push them, or use --local"
    branch=$(git -C "$top" rev-parse --abbrev-ref HEAD)
    [ -n "$ref" ] || ref=$branch
    if [ "$ref" = "$branch" ]; then
      git -C "$top" rev-parse --verify -q '@{u}' >/dev/null || die "$branch is not pushed to $repo; push it, or use --local"
      [ "$(git -C "$top" rev-list --count '@{u}..HEAD')" = 0 ] || die "$branch has commits not pushed to $repo; push them, or use --local"
    fi
  fi
  local run prompt eve=""
  resolve_agent
  node_args
  command -v node >/dev/null || die "node is not installed"
  command -v screen >/dev/null || die "screen is not installed"
  [ -e "$PROJECT/.env.local" ] || [ -e "$AGENT/.env.local" ] || [ -n "${AI_GATEWAY_API_KEY:-}" ] || die "missing $PROJECT/.env.local (or the agent's .env.local) or AI_GATEWAY_API_KEY"
  eve=$(eve_bin)
  run=$(mktemp -d "${TMPDIR:-/tmp}/implementor.XXXXXX")
  prompt="Implement $source in the GitHub repository $repo${ref:+, starting from branch $ref}. Follow the aspira-implementor skill. $([ "$PR" = 1 ] && echo 'Push the branch and open a draft pull request.' || echo 'Push the branch; do not open a pull request.') Report status, branch, commits, the feature table, deviations, blockers and the pull request link if any."
  printf '%s\n' "$repo" > "$run/repo"
  printf '%s\n' "${NODE_ARGS[@]}" > "$run/node-args"
  agent_json > "$run/agent.json"
  agent_line > "$run/agent"
  date +%s > "$run/started"
  cat > "$run/run.sh" <<'RUNNER'
#!/bin/bash
NODE_ARGS=()
while IFS= read -r line; do NODE_ARGS+=("$line"); done < "$RUN/node-args"
cd "$AGENT" || exit 1
node "${NODE_ARGS[@]}" "$EVE" invoke "$PROMPT" > "$RUN/log" 2>&1
code=$?
printf '%s\n' "$code" > "$RUN/exit"
RUNNER
  chmod +x "$run/run.sh"
  AGENT="$AGENT" EVE="$eve" PROMPT="$prompt" RUN="$run" screen -dmS "implementor-$(basename "$run")" "$run/run.sh"
  printf 'started\nrun: %s\nrepo: %s\nsource: %s\nref: %s\npull request: %s\n' "$run" "$repo" "$source" "${ref:-default branch}" "$([ "$PR" = 1 ] && echo draft || echo no)"
  agent_line
}
# One synchronous step of a --local build: no model calls here, so no screen, gateway key or wait.
local_step() {
  [ -n "$SOURCE" ] || die "usage: implementor.sh local <plan.review | plan.reviewed.md | spec.md> [--repo DIR] [--guidelines FILE] [--max-parallel N] [--serial] [--work DIR] [--finish]"
  [ -z "$REF$PR" ] || die "--ref and --pr are for the agent; --local builds the checkout you are in and pushes nothing"
  if [ -n "$REPO" ] && is_github "$REPO"; then die "--local builds a local checkout; $REPO is a GitHub repository. Drop --local to launch the agent on it"; fi
  local args=("$(absolute_path "$SOURCE")")
  [ -z "$REPO" ] || args+=(--repo "$(absolute_path "$REPO")")
  [ -z "$GUIDELINES" ] || args+=(--guidelines "$GUIDELINES")
  [ -z "$PARALLEL" ] || args+=(--max-parallel "$PARALLEL")
  [ -z "$SERIAL" ] || args+=(--serial)
  [ -z "$WORK" ] || args+=(--work "$WORK")
  [ -z "$FINISH" ] || args+=(--finish)
  command -v node >/dev/null || die "node is not installed"
  resolve_agent
  agent_node scripts/local.ts "${args[@]}"
}
cmd_status() {
  local run=${1:?usage: implementor.sh status RUN} elapsed
  [ -f "$run/started" ] || die "not a run directory: $run"
  elapsed=$(( $(date +%s) - $(cat "$run/started") ))
  if [ ! -f "$run/exit" ]; then
    printf 'running (%ss)\nlog: %s/log\n' "$elapsed" "$run"
    [ ! -f "$run/log" ] || tail -n 3 "$run/log"
    return
  fi
  printf 'finished (%ss), exit %s\nrepo: %s\n' "$elapsed" "$(cat "$run/exit")" "$(cat "$run/repo")"
  [ ! -f "$run/agent" ] || cat "$run/agent"
  tail -n 60 "$run/log"
}
cmd_wait() {
  local run=${1:?usage: implementor.sh wait RUN [--max SECONDS]} max=30 deadline
  if [ "${2:-}" = --max ]; then max=${3:?}; fi
  [[ $max =~ ^[0-9]+$ ]] && [ "$max" -ge 1 ] && [ "$max" -le 60 ] || die "--max must be 1..60 seconds"
  [ -f "$run/started" ] || die "not a run directory: $run"
  deadline=$(( $(date +%s) + max ))
  while [ ! -f "$run/exit" ] && [ "$(date +%s)" -lt "$deadline" ]; do sleep 1; done
  cmd_status "$run"
}
case ${1:-} in
  start) shift; cmd_start "$@" ;;
  local) shift; parse "$@"; local_step ;;
  status) shift; cmd_status "$@" ;;
  wait|watch) shift; cmd_wait "$@" ;;
  *) die "usage: implementor.sh start <path-in-repo> [--repo owner/name | --repo DIR] [--ref BRANCH] [--pr] | status RUN | wait RUN [--max SECONDS] | local <source> [--repo DIR] [--guidelines FILE] [--max-parallel N] [--serial] [--work DIR] [--finish]" ;;
esac
