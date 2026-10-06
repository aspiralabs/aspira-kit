#!/bin/bash
# Launch the official code-analyzer without keeping the caller's tool invocation open (start),
# or step a --local run whose fix model is the calling Claude Code session (local).
set -euo pipefail

NAME=code-analyzer
PKG=@aspiralabs/code-analyzer
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
# Which code-analyzer runs, in this order: CODE_ANALYZER_AGENT_DIR (kit development only; the report says so),
# the @aspiralabs/code-analyzer installed under the project (walking up from the working directory, then
# from this script's location), then this script's own package. $ASPIRA_KIT is never consulted.
# Sets AGENT, AGENT_SOURCE (env | installed | package), AGENT_VERSION and PROJECT.
resolve_agent() {
  local here dir
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  AGENT="" AGENT_SOURCE="" PROJECT=""
  for dir in "${CODE_ANALYZER_AGENT_DIR:-}" "${STATIC_ANALYSIS_AGENT_DIR:-}"; do
    [ -n "$dir" ] || continue
    is_agent "$dir" || die "CODE_ANALYZER_AGENT_DIR is not the $PKG package: $dir"
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
  [ -n "$AGENT" ] || die "cannot find $PKG: install @aspiralabs/agents in the project (kit init), or set CODE_ANALYZER_AGENT_DIR for kit development"
  [ -n "$PROJECT" ] || PROJECT=$(project_root)
  AGENT_VERSION=$(sed -nE 's/^ *"version": *"([^"]+)".*/\1/p' "$AGENT/package.json" | head -n 1)
  case $AGENT_SOURCE:$AGENT in
    env:*) echo "$NAME: CODE_ANALYZER_AGENT_DIR is set: running kit source at $AGENT, not the installed $PKG" >&2 ;;
    *:*/node_modules/*) ;;
    *) echo "$NAME: running kit source at $AGENT, not the installed $PKG" >&2 ;;
  esac
}
agent_line() { printf 'agent: %s@%s (%s, %s)\n' "$PKG" "$AGENT_VERSION" "$AGENT_SOURCE" "$AGENT"; }
json_string() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
# true when the agent runs from an installed package. A function, not an inline `$(case …)`: bash 3.2
# (macOS /bin/bash) mis-parses the pattern's `)` inside a command substitution and reports a syntax error.
agent_installed() { case $AGENT in */node_modules/*) echo true ;; *) echo false ;; esac; }
agent_json() { printf '{"name":"%s","version":"%s","path":"%s","source":"%s","installed":%s}\n' "$PKG" "$(json_string "$AGENT_VERSION")" "$(json_string "$AGENT")" "$AGENT_SOURCE" "$(agent_installed)"; }
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
# owner/name from a GitHub URL, git@ URL or shorthand; empty when the source is not remote.
remote_slug() {
  printf '%s' "$1" | sed -nE 's#^(https?://(www\.)?github\.com/|git@github\.com:)?([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/?$#\3/\4#p' | sed -E 's/\.git$//'
}
# A directory is analyzed as itself (one app of a multi-app repository stays that app), made
# absolute because the agent runs from its own package directory. It must be inside git.
local_dir() {
  local dir
  dir=$(cd "$1" && pwd -P) || die "not a directory: $1"
  git -C "$dir" rev-parse --show-toplevel >/dev/null 2>&1 || die "not a git repository: $dir"
  printf '%s' "$dir"
}
absolute_path() {
  case $1 in /*) printf '%s' "$1" ;; *) printf '%s/%s' "$PWD" "$1" ;; esac
}
# The board step before a separate-process run: resolve the ticket, check its Status (a refusal exits 3
# before anything is launched) and pull its pages into .work/<id>-<slug>/. The analyzer claims nothing.
# Reads the key=value lines of scripts/ticket.ts into T_FOLDER, T_ID, T_TITLE, T_URL, T_BEFORE, T_STATUS.
ticket_start() {
  local ticket=$1 top=$2 out code line key value
  out=$(mktemp "${TMPDIR:-/tmp}/code-analyzer-ticket.XXXXXX")
  agent_node scripts/ticket.ts start "$ticket" --repo "$top" ${FORCE_PULL:+--force-pull} > "$out"; code=$?
  if [ "$code" != 0 ]; then rm -f "$out"; exit "$code"; fi
  T_FOLDER="" T_ID="" T_TITLE="" T_URL="" T_BEFORE="" T_STATUS=""
  while IFS= read -r line; do
    key=${line%%=*}; value=${line#*=}
    case $key in
      folder) T_FOLDER=$value ;; id) T_ID=$value ;; title) T_TITLE=$value ;; url) T_URL=$value ;;
      before) T_BEFORE=$value ;; status) T_STATUS=$value ;;
    esac
  done < "$out"
  rm -f "$out"
  [ -n "$T_FOLDER" ] || die "the ticket step printed no working folder"
}
# The repository root the ticket's working folder lives under: the git top of the working directory.
repo_top() { git -C "$PWD" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$PWD"; }
cmd_start() {
  local source="" push="" ref="" out="" rounds="" warnings="" knowledge="" guidelines="" no_ticket="" app="" FORCE_PULL=""
  while [ $# -gt 0 ]; do
    case $1 in
      --push) push=1; shift ;;
      --fix-warnings) warnings=1; shift ;;
      --no-ticket) no_ticket=1; shift ;;
      --force-pull) FORCE_PULL=1; shift ;;
      --app) [ $# -ge 2 ] || die "--app needs a directory"; app=$2; shift 2 ;;
      --ref) [ $# -ge 2 ] || die "--ref needs a branch"; ref=$2; shift 2 ;;
      --output) [ $# -ge 2 ] || die "--output needs a path"; out=$2; shift 2 ;;
      --knowledge) [ $# -ge 2 ] || die "--knowledge needs a folder"; [ -d "$2" ] || die "--knowledge is a folder (REQUIRED.md, INDEX.md, pages): $2"; knowledge=$(cd "$2" && pwd -P); shift 2 ;;
      --guidelines) [ $# -ge 2 ] || die "--guidelines needs a file"; [ -f "$2" ] || die "--guidelines is a REQUIRED.md file: $2"; guidelines=$(absolute_path "$2"); shift 2 ;;
      --max-rounds) [ $# -ge 2 ] || die "--max-rounds needs a number"; rounds=$2; shift 2 ;;
      --local) die "--local runs in this session: use the local command, not start" ;;
      --verify) die "--verify is for local" ;;
      -*) die "unknown option: $1" ;;
      *) [ -z "$source" ] || die "one ticket at a time (or one repository with --no-ticket)"; source=${1#@}; shift ;;
    esac
  done
  local run mode slug prompt eve="" ticket="" folder="" top=""
  if [ -n "$no_ticket" ]; then
    [ -n "$source" ] || die "usage: code-analyzer.sh start <repo-path | github-url | owner/name> --no-ticket [--knowledge DIR | --guidelines FILE] [--push] [--ref BRANCH] [--output DIR] [--max-rounds N] [--fix-warnings]"
    [ -z "$app" ] || die "--app goes with a ticket; with --no-ticket name the directory as the argument"
  else
    [ -z "$source" ] || [ ! -e "$source" ] || die "$source is a file path, not a ticket; pass --no-ticket to run on a path with no board"
    ticket=$source
    source=${app:-$(repo_top)}
    [ -z "$push$ref" ] || die "--push and --ref apply to remote repositories, which a ticket run never analyzes; pass --no-ticket"
  fi
  resolve_agent
  node_args
  command -v node >/dev/null || die "node is not installed"
  command -v screen >/dev/null || die "screen is not installed"
  [ -e "$PROJECT/.env.local" ] || [ -e "$AGENT/.env.local" ] || [ -n "${AI_GATEWAY_API_KEY:-}" ] || die "missing $PROJECT/.env.local (or the agent's .env.local) or AI_GATEWAY_API_KEY"
  if [ -d "$source" ]; then
    mode=local
    source=$(local_dir "$source") || exit 1
    [ -z "$push" ] || die "--push applies to remote repositories only"
    [ -z "$ref" ] || die "--ref applies to remote repositories only"
    out=${out:-"$source/.static-analysis"}
  else
    slug=$(remote_slug "$source")
    [ -n "$slug" ] || die "not a directory or a GitHub repository: $source"
    mode=remote
    out=${out:-"${TMPDIR:-/tmp}/static-analysis/${slug//\//-}"}
  fi
  [[ $out = /* ]] || out="$PWD/$out"
  if [ -z "$no_ticket" ]; then
    top=$(git -C "$source" rev-parse --show-toplevel)
    ticket_start "$ticket" "$top"
    folder=$T_FOLDER
    printf 'ticket: %s %s (%s)\nstatus: %s -> %s\nfolder: %s\n' "$T_ID" "$T_TITLE" "$T_URL" "$T_BEFORE" "$T_STATUS" "$folder"
  fi
  [ "$mode" = local ] || eve=$(eve_bin)
  run=$(mktemp -d "${TMPDIR:-/tmp}/code-analyzer.XXXXXX")
  prompt="Run static analysis on the repository $source and fix everything it reports. Call static-analysis once with source exactly \"$source\" and outputDir \"$out\"."
  [ -z "$ref" ] || prompt="$prompt Use ref \"$ref\"."
  [ -z "$push" ] || prompt="$prompt Push the branch and open a pull request (push: true)."
  [ -z "$rounds" ] || prompt="$prompt Cap it at $rounds rounds."
  [ -z "$warnings" ] || prompt="$prompt Also fix warnings (fixWarnings: true)."
  [ -z "$knowledge" ] || prompt="$prompt Use the guidelines folder knowledge \"$knowledge\"."
  [ -z "$guidelines" ] || prompt="$prompt Use the guidelines file guidelines \"$guidelines\"."
  [ -z "$folder" ] || prompt="$prompt The ticket's board moves and pushes are made by the launcher around this run; do not call board yourself."
  prompt="$prompt Report the status, counts, edited files and the report path."
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
if [ "$MODE" = local ]; then
  args=("$SOURCE" --output "$OUTPUT")
  [ -z "$ROUNDS" ] || args+=(--max-rounds "$ROUNDS")
  [ -z "$WARNINGS" ] || args+=(--fix-warnings)
  [ -z "$KNOWLEDGE" ] || args+=(--knowledge "$KNOWLEDGE")
  [ -z "$GUIDELINES" ] || args+=(--guidelines "$GUIDELINES")
  node "${NODE_ARGS[@]}" "$AGENT/scripts/static-analysis.ts" "${args[@]}" > "$RUN/log" 2>&1
else
  node "${NODE_ARGS[@]}" "$EVE" invoke "$PROMPT" > "$RUN/log" 2>&1
fi
code=$?
printf '%s\n' "$code" > "$RUN/exit"
# The report folder records which agent package ran.
[ ! -d "$OUTPUT" ] || cp "$RUN/agent.json" "$OUTPUT/agent-version.json"
# The board step after the run: the analyzer pushes nothing and makes no move; the trace records the run.
if [ -n "$FOLDER" ]; then
  if [ "$code" = 0 ]; then outcome=--ok; status=clean; else outcome=--failed; status=partial; fi
  node "${NODE_ARGS[@]}" "$AGENT/scripts/ticket.ts" finish --repo "$REPO_TOP" --folder "$FOLDER" "$outcome" --run-status "$status" --export "$OUTPUT" >> "$RUN/log" 2>&1
fi
RUNNER
  chmod +x "$run/run.sh"
  MODE="$mode" AGENT="$AGENT" EVE="$eve" SOURCE="$source" OUTPUT="$out" ROUNDS="$rounds" WARNINGS="$warnings" KNOWLEDGE="$knowledge" GUIDELINES="$guidelines" PROMPT="$prompt" RUN="$run" FOLDER="$folder" REPO_TOP="$top" screen -dmS "static-analysis-$(basename "$run")" "$run/run.sh"
  printf 'started\nrun: %s\nmode: %s\nsource: %s\noutput: %s\n' "$run" "$mode" "$source" "$out"
  agent_line
}
# One synchronous step of a --local run: no model call here, so no screen, gateway key or wait.
# With a ticket the driver prints the board stage first (the ticket's resolve and pull for the
# session to perform), then the knowledge and fix stages, then the exported run with the board trace.
cmd_local() {
  local source="" args=() no_ticket="" app="" ticket="" top
  while [ $# -gt 0 ]; do
    case $1 in
      --local) shift ;;
      --no-ticket) no_ticket=1; shift ;;
      --app) [ $# -ge 2 ] || die "--app needs a directory"; app=$2; shift 2 ;;
      --no-fix|--fix-warnings|--finish|--force-pull|--verify) args+=("$1"); shift ;;
      --knowledge|--guidelines|--output) [ $# -ge 2 ] || die "$1 needs a path"; args+=("$1" "$(absolute_path "$2")"); shift 2 ;;
      --max-rounds) [ $# -ge 2 ] || die "--max-rounds needs a number"; args+=("$1" "$2"); shift 2 ;;
      -*) die "unknown option: $1" ;;
      *) [ -z "$source" ] || die "one ticket at a time (or one repository with --no-ticket)"; source=${1#@}; shift ;;
    esac
  done
  if [ -n "$no_ticket" ]; then
    [ -n "$source" ] || die "usage: code-analyzer.sh local <repo-path> --no-ticket [--knowledge DIR | --guidelines FILE] [--max-rounds N] [--fix-warnings] [--no-fix] [--output DIR] [--finish]"
    [ -z "$app" ] || die "--app goes with a ticket; with --no-ticket name the directory as the argument"
    [ -d "$source" ] || die "--local needs a local path; a GitHub repository is fixed in the eve sandbox (use start): $source"
  else
    [ -z "$source" ] || [ ! -e "$source" ] || die "$source is a file path, not a ticket; pass --no-ticket to run on a path with no board"
    ticket=$source
    source=${app:-$(repo_top)}
    [ -d "$source" ] || die "--app needs a local directory: $source"
  fi
  source=$(local_dir "$source") || exit 1
  top=$(git -C "$source" rev-parse --show-toplevel)
  if [ -n "$no_ticket" ]; then args+=(--no-ticket); elif [ -n "$ticket" ]; then args+=(--ticket "$ticket"); fi
  command -v node >/dev/null || die "node is not installed"
  resolve_agent
  agent_node scripts/local.ts --repo "$top" ${args[@]+"${args[@]}"} "$source"
}
cmd_status() {
  local run=${1:?usage: code-analyzer.sh status RUN} elapsed
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
  printf 'Report: %s/report.md\nRemaining diagnostics: %s/diagnostics.json\n' "$(cat "$run/output")" "$(cat "$run/output")"
}
cmd_wait() {
  local run=${1:?usage: code-analyzer.sh wait RUN [--max SECONDS]} max=30 deadline
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
  *) die "usage: code-analyzer.sh start [TICKET [--app DIR] | SOURCE --no-ticket] [--force-pull] [--knowledge DIR | --guidelines FILE] [--push] [--ref BRANCH] [--output DIR] [--max-rounds N] [--fix-warnings] | status RUN | wait RUN [--max SECONDS] | local [TICKET [--app DIR] | REPO-PATH --no-ticket] [--force-pull] [--verify] [--knowledge DIR | --guidelines FILE] [--max-rounds N] [--fix-warnings] [--no-fix] [--output DIR] [--finish]" ;;
esac
