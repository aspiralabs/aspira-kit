#!/bin/bash
# Launch the official pr-reviewer without keeping the caller's tool invocation open (start/status/wait),
# or step a --local review whose model work runs in the calling Claude Code session (local).
set -euo pipefail

NAME=pr-reviewer
PKG=@aspiralabs/pr-reviewer
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
# Which pr-reviewer runs, in this order: PR_REVIEWER_AGENT_DIR (kit development only; the report says so),
# the @aspiralabs/pr-reviewer installed under the project (walking up from the working directory, then
# from this script's location), then this script's own package. $ASPIRA_KIT is never consulted.
# Sets AGENT, AGENT_SOURCE (env | installed | package), AGENT_VERSION and PROJECT.
resolve_agent() {
  local here dir
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  AGENT="" AGENT_SOURCE="" PROJECT=""
  for dir in "${PR_REVIEWER_AGENT_DIR:-}"; do
    [ -n "$dir" ] || continue
    is_agent "$dir" || die "PR_REVIEWER_AGENT_DIR is not the $PKG package: $dir"
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
  [ -n "$AGENT" ] || die "cannot find $PKG: install @aspiralabs/agents in the project (kit init), or set PR_REVIEWER_AGENT_DIR for kit development"
  [ -n "$PROJECT" ] || PROJECT=$(project_root)
  AGENT_VERSION=$(sed -nE 's/^ *"version": *"([^"]+)".*/\1/p' "$AGENT/package.json" | head -n 1)
  case $AGENT_SOURCE:$AGENT in
    env:*) echo "$NAME: PR_REVIEWER_AGENT_DIR is set: running kit source at $AGENT, not the installed $PKG" >&2 ;;
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
# A directory is a local repository and is made absolute (the agent runs from its own package
# directory); anything else is passed on as a GitHub PR reference.
absolute_source() {
  if [ -d "$1" ]; then (cd "$1" && pwd -P); else printf '%s\n' "$1"; fi
}
absolute_path() {
  if [[ $1 = /* ]]; then printf '%s\n' "$1"; else printf '%s/%s\n' "$PWD" "$1"; fi
}
SOURCE="" POSITIONAL="" NO_TICKET="" FORCE_PULL="" VERIFY="" REPO="" BRANCH="" BASE="" ROUNDS="" OUT="" KNOWLEDGE="" SINCE="" MAX_COST="" NO_COMMENT="" FINISH="" YES=""
is_pr() { [[ $1 =~ ^(https?://(www\.)?github\.com/[^/]+/[^/]+/pull/[0-9]+|[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#[0-9]+)/?$ ]]; }
# The ticket argument (F1 of the ticket flow): a board ID such as NOM-4, a Notion page URL, nothing
# (the one folder under .work/ that holds a ticket.md), or, with --no-ticket, the GitHub PR or repository
# path exactly as before. Sets POSITIONAL, NO_TICKET, FORCE_PULL, VERIFY, REPO and the review options;
# with --no-ticket, SOURCE.
parse() {
  local mode=$1; shift
  while [ $# -gt 0 ]; do
    case $1 in
      --no-ticket) NO_TICKET=1; shift ;;
      --force-pull) FORCE_PULL=1; shift ;;
      --verify) [ "$mode" = local ] || die "--verify is for local"; VERIFY=1; shift ;;
      --repo) [ $# -ge 2 ] || die "--repo needs a directory"; REPO=$2; shift 2 ;;
      --branch) [ $# -ge 2 ] || die "--branch needs a name"; BRANCH=$2; shift 2 ;;
      --base) [ $# -ge 2 ] || die "--base needs a ref"; BASE=$2; shift 2 ;;
      --max-rounds) [ $# -ge 2 ] || die "--max-rounds needs a number"; ROUNDS=$2; shift 2 ;;
      --max-cost) [ $# -ge 2 ] || die "--max-cost needs a number of dollars"; MAX_COST=$2; shift 2 ;;
      --since) [ $# -ge 2 ] || die "--since needs the previous review directory"; SINCE=$(absolute_path "$2"); shift 2 ;;
      --output) [ $# -ge 2 ] || die "--output needs a path"; OUT=$(absolute_path "$2"); shift 2 ;;
      --knowledge) [ "$mode" = local ] || die "--knowledge is for local; the agent loads the guidelines itself"; [ $# -ge 2 ] || die "--knowledge needs a path"; KNOWLEDGE=$(absolute_path "$2"); shift 2 ;;
      --no-comment) NO_COMMENT=1; shift ;;
      --yes) YES=1; shift ;;
      --local) shift ;;
      --finish) [ "$mode" = local ] || die "--finish is for local"; FINISH=1; shift ;;
      -*) die "unknown option: $1" ;;
      *) [ -z "$POSITIONAL" ] || die "one ticket at a time (or one PR with --no-ticket)"; POSITIONAL=${1#@}; shift ;;
    esac
  done
  if [ -n "$ROUNDS" ]; then
    [[ $ROUNDS =~ ^[0-9]+$ ]] && [ "$ROUNDS" -ge 1 ] && [ "$ROUNDS" -le 10 ] || die "--max-rounds must be 1..10"
  fi
  if [ -n "$MAX_COST" ]; then
    [[ $MAX_COST =~ ^[0-9]+(\.[0-9]+)?$ ]] && [ "$MAX_COST" != 0 ] || die "--max-cost must be a number of dollars above 0"
  fi
  [ -z "$SINCE" ] || [ -f "$SINCE/findings.md" ] || die "--since $SINCE has no findings.md"
  REPO=$(git -C "${REPO:-$PWD}" rev-parse --show-toplevel 2>/dev/null || true)
  if [ -n "$NO_TICKET" ]; then
    [ -n "$REPO" ] || REPO=$PWD
    [ -n "$POSITIONAL" ] || die "usage: pr-reviewer.sh $mode <github-pr | repo-path> --no-ticket [--branch B] [--base main] [--max-rounds N] [--max-cost USD] [--since DIR] [--no-comment] [--output DIR]$([ "$mode" = local ] && echo ' [--knowledge DIR] [--finish]' || echo ' [--yes]')"
    SOURCE=$(absolute_source "$POSITIONAL")
  else
    if [ -n "$POSITIONAL" ] && [ -e "$POSITIONAL" ]; then die "$POSITIONAL is a file path, not a ticket; pass --no-ticket to run on a path with no board"; fi
    if [ -n "$POSITIONAL" ] && is_pr "$POSITIONAL"; then die "$POSITIONAL is a pull request, not a ticket; pass --no-ticket to review it with no board"; fi
    [ -z "$BRANCH$BASE" ] || die "--branch and --base are for a repository path with --no-ticket; a ticket names its PR"
    [ -n "$REPO" ] || die "run inside the project's Git repository or pass --repo; the ticket's working folder lives under its .work/"
  fi
}
# The board step before a separate-process run: resolve the ticket, check its Status and PR (a refusal
# exits 3 before anything is launched) and pull its pages into .work/<id>-<slug>/. Reads the key=value
# lines of scripts/ticket.ts into T_FOLDER, T_ID, T_TITLE, T_URL, T_BEFORE, T_STATUS, T_PR.
ticket_start() {
  local out code line key value
  out=$(mktemp "${TMPDIR:-/tmp}/pr-reviewer-ticket.XXXXXX")
  agent_node scripts/ticket.ts start "$POSITIONAL" --repo "$REPO" ${FORCE_PULL:+--force-pull} > "$out"; code=$?
  if [ "$code" != 0 ]; then rm -f "$out"; exit "$code"; fi
  T_FOLDER="" T_ID="" T_TITLE="" T_URL="" T_BEFORE="" T_STATUS="" T_PR=""
  while IFS= read -r line; do
    key=${line%%=*}; value=${line#*=}
    case $key in
      folder) T_FOLDER=$value ;; id) T_ID=$value ;; title) T_TITLE=$value ;; url) T_URL=$value ;;
      before) T_BEFORE=$value ;; status) T_STATUS=$value ;; pr) T_PR=$value ;;
    esac
  done < "$out"
  rm -f "$out"
  [ -n "$T_FOLDER" ] || die "the ticket step printed no working folder"
}
# What a cloud run is likely to cost, from the diff and this package's previous cost.md files.
# Printed, not confirmed; --yes skips it. An estimate that cannot be computed never blocks the run.
print_estimate() {
  local args=("$SOURCE")
  [ -z "$BRANCH" ] || args+=(--branch "$BRANCH")
  [ -z "$BASE" ] || args+=(--base "$BASE")
  [ -z "$ROUNDS" ] || args+=(--max-rounds "$ROUNDS")
  agent_node scripts/estimate.ts "${args[@]}" || echo "estimate unavailable (see above); starting anyway"
}
cmd_start() {
  parse start "$@"
  local run prompt eve="" folder=""
  resolve_agent
  node_args
  command -v node >/dev/null || die "node is not installed"
  command -v screen >/dev/null || die "screen is not installed"
  [ -e "$PROJECT/.env.local" ] || [ -e "$AGENT/.env.local" ] || [ -n "${AI_GATEWAY_API_KEY:-}" ] || die "missing $PROJECT/.env.local (or the agent's .env.local) or AI_GATEWAY_API_KEY"
  eve=$(eve_bin)
  if [ -z "$NO_TICKET" ]; then
    ticket_start
    folder=$T_FOLDER
    SOURCE=$T_PR
    [ -n "$SOURCE" ] || die "$T_ID has no PR property set; the implementor sets it when it opens the PR"
    OUT=${OUT:-"$folder/pr-review"}
    printf 'ticket: %s %s (%s)\nstatus: %s -> %s\nfolder: %s\n' "$T_ID" "$T_TITLE" "$T_URL" "$T_BEFORE" "$T_STATUS" "$folder"
  fi
  if [ -d "$SOURCE" ]; then
    if [ -n "$BRANCH" ]; then prompt="Review the branch $BRANCH in $SOURCE against ${BASE:-main}"; else prompt="Review the checked-out branch in $SOURCE against ${BASE:-main}"; fi
  else
    [ -z "$BRANCH$BASE" ] || die "--branch and --base are for a local repository; a GitHub PR already says what it is against"
    prompt="Review $SOURCE"
  fi
  [ -z "$SINCE" ] || prompt="$prompt again, since the previous review in $SINCE"
  [ -z "$ROUNDS" ] || prompt="$prompt, cap it at $ROUNDS rounds"
  [ -z "$MAX_COST" ] || prompt="$prompt, stop at \$$MAX_COST"
  prompt="$prompt."
  [ -z "$OUT" ] || prompt="$prompt Write the review to $OUT."
  [ -z "$NO_COMMENT" ] || prompt="$prompt Do not comment on the PR."
  [ -z "$folder" ] || prompt="$prompt The ticket's board moves and pushes are made by the launcher around this run; do not call board yourself."
  [ -n "$YES" ] || print_estimate
  run=$(mktemp -d "${TMPDIR:-/tmp}/pr-reviewer.XXXXXX")
  printf '%s\n' "$SOURCE" > "$run/source"
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
# The board step after the run: push review.md to the ticket as PR Review. The reviewer makes no move.
if [ -n "$FOLDER" ]; then
  if [ "$code" = 0 ] && [ -f "$OUTPUT/review.md" ]; then outcome=--ok; status=complete; else outcome=--failed; status=incomplete; fi
  node "${NODE_ARGS[@]}" "$AGENT/scripts/ticket.ts" finish --repo "$REPO" --folder "$FOLDER" "$outcome" --run-status "$status" --export "$OUTPUT" >> "$RUN/log" 2>&1
fi
RUNNER
  chmod +x "$run/run.sh"
  AGENT="$AGENT" EVE="$eve" PROMPT="$prompt" RUN="$run" FOLDER="$folder" REPO="$REPO" OUTPUT="$OUT" screen -dmS "pr-review-$(basename "$run")" "$run/run.sh"
  printf 'started\nrun: %s\nsource: %s\n' "$run" "$SOURCE"
  agent_line
}
# One synchronous step of a --local review: no model calls here, so no screen, gateway key or wait.
# The driver prints the board stage first (the ticket's resolve and pull for the session to perform),
# then the next stage's tasks (prompt + output file each) or the exported review with the end board
# actions; --verify is the last step, once the session pushed the review page.
cmd_local() {
  parse local "$@"
  local args=(--repo "$REPO")
  if [ -n "$NO_TICKET" ]; then args+=(--no-ticket "$SOURCE"); elif [ -n "$POSITIONAL" ]; then args+=(--ticket "$POSITIONAL"); fi
  [ -z "$BRANCH" ] || args+=(--branch "$BRANCH")
  [ -z "$BASE" ] || args+=(--base "$BASE")
  [ -z "$ROUNDS" ] || args+=(--max-rounds "$ROUNDS")
  [ -z "$MAX_COST" ] || args+=(--max-cost "$MAX_COST")
  [ -z "$SINCE" ] || args+=(--since "$SINCE")
  [ -z "$NO_COMMENT" ] || args+=(--no-comment)
  [ -z "$OUT" ] || args+=(--output "$OUT")
  [ -z "$KNOWLEDGE" ] || args+=(--knowledge "$KNOWLEDGE")
  [ -z "$FORCE_PULL" ] || args+=(--force-pull)
  [ -z "$VERIFY" ] || args+=(--verify)
  [ -z "$FINISH" ] || args+=(--finish)
  command -v node >/dev/null || die "node is not installed"
  resolve_agent
  agent_node scripts/local.ts "${args[@]}"
}
cmd_status() {
  local run=${1:?usage: pr-reviewer.sh status RUN} elapsed
  [ -f "$run/started" ] || die "not a run directory: $run"
  elapsed=$(( $(date +%s) - $(cat "$run/started") ))
  if [ ! -f "$run/exit" ]; then
    printf 'running (%ss)\nlog: %s/log\n' "$elapsed" "$run"
    [ ! -f "$run/log" ] || tail -n 3 "$run/log"
    return
  fi
  printf 'finished (%ss), exit %s\nsource: %s\nlog: %s/log\n' "$elapsed" "$(cat "$run/exit")" "$(cat "$run/source")" "$run"
  [ ! -f "$run/agent" ] || cat "$run/agent"
  tail -n 60 "$run/log"
}
cmd_wait() {
  local run=${1:?usage: pr-reviewer.sh wait RUN [--max SECONDS]} max=30 deadline
  if [ "${2:-}" = --max ]; then max=${3:?}; fi
  [[ $max =~ ^[0-9]+$ ]] && [ "$max" -ge 1 ] && [ "$max" -le 60 ] || die "--max must be 1..60 seconds"
  [ -f "$run/started" ] || die "not a run directory: $run"
  deadline=$(( $(date +%s) + max ))
  while [ ! -f "$run/exit" ] && [ "$(date +%s)" -lt "$deadline" ]; do sleep 1; done
  cmd_status "$run"
}
case ${1:-} in
  start) shift; cmd_start "$@" ;;
  local) shift; cmd_local "$@" ;;
  status) shift; cmd_status "$@" ;;
  wait|watch) shift; cmd_wait "$@" ;;
  *) die "usage: pr-reviewer.sh start [TICKET | SOURCE --no-ticket] [--force-pull] [--repo DIR] [--branch B] [--base main] [--max-rounds N] [--max-cost USD] [--since DIR] [--no-comment] [--output DIR] [--yes] | status RUN | wait RUN [--max SECONDS] | local [TICKET | SOURCE --no-ticket] [--force-pull] [--verify] [--repo DIR] [--branch B] [--base main] [--max-rounds N] [--max-cost USD] [--since DIR] [--no-comment] [--output DIR] [--knowledge DIR] [--finish]" ;;
esac
