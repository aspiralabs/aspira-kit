#!/bin/bash
# Launch the official groomer without keeping the caller's tool invocation open (start/status/wait),
# or step a --local run whose model work runs in the calling Claude Code session (local).
set -euo pipefail

NAME=groomer
PKG=@aspiralabs/groomer
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
# In a multi-app repository (apps/web owns package.json and node_modules, Claude Code runs at the
# root) `kit init --app` records the app in the root's aspira.json. Prints that app's directory from
# the nearest aspira.json at or above DIR (this script's location, under <root>/.claude/skills/),
# or nothing when there is none: the single-app case, where the walk-up below finds the package.
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
# Which groomer runs, in this order: GROOMER_AGENT_DIR (kit development only; the report says so),
# the @aspiralabs/groomer installed under the project (the app named in the root's aspira.json, then
# walking up from the working directory, then from this script's location), then this script's own package. $ASPIRA_KIT is never consulted.
# Sets AGENT, AGENT_SOURCE (env | installed | package), AGENT_VERSION and PROJECT.
resolve_agent() {
  local here dir app_dir own
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  AGENT="" AGENT_SOURCE="" PROJECT=""
  for dir in "${GROOMER_AGENT_DIR:-}"; do
    [ -n "$dir" ] || continue
    is_agent "$dir" || die "GROOMER_AGENT_DIR is not the $PKG package: $dir"
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
  [ -n "$AGENT" ] || die "cannot find $PKG: install @aspiralabs/agents in the project (kit init), or set GROOMER_AGENT_DIR for kit development"
  [ -n "$PROJECT" ] || PROJECT=$(project_root)
  AGENT_VERSION=$(sed -nE 's/^ *"version": *"([^"]+)".*/\1/p' "$AGENT/package.json" | head -n 1)
  case $AGENT_SOURCE:$AGENT in
    env:*) echo "$NAME: GROOMER_AGENT_DIR is set: running kit source at $AGENT, not the installed $PKG" >&2 ;;
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
absolute_file() {
  [ -f "$1" ] || die "no such file: $1"
  echo "$(cd "$(dirname "$1")" && pwd -P)/$(basename "$1")"
}
# --parent-run <run-id>:<nonce> marks a step of a build-feature run (KIT-19): ticket.ts and the local
# driver check that it names the run's pending step, and the step writes and attaches no telemetry of
# its own. A malformed value is refused here, before anything runs (exit 3, as ticket.ts refuses).
check_parent_run() {
  local pattern='^run-[0-9]{8}T[0-9]{6}Z(-[0-9]+)?:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
  [ -n "$PARENT_RUN" ] || return 0
  if [[ ! $PARENT_RUN =~ $pattern ]]; then
    echo "$NAME: refused: --parent-run must be <run-id>:<nonce>, the build-feature run id and the nonce of its pending step" >&2
    exit 3
  fi
}
# The ticket argument (F1 of the ticket flow): a board ID such as NOM-4, a Notion page URL, or nothing
# (the one folder under .work/ that holds a ticket.md). The groomer writes to the card, so it has no
# --no-ticket mode. Sets POSITIONAL, FORCE_PULL, FORCE_RUN, VERIFY, GUIDELINES, REPO, OUT, FINISH,
# TAKE_RECOMMENDED, PARENT_RUN and ATTACH (the --local verify step's telemetry attach result).
parse() {
  POSITIONAL="" FORCE_PULL="" FORCE_RUN="" VERIFY="" GUIDELINES="" REPO="" OUT="" FINISH="" TAKE_RECOMMENDED="" PARENT_RUN="" ATTACH="" T_RUN_ID="" T_RUN_STARTED=""
  while [ $# -gt 0 ]; do
    case $1 in
      --no-ticket) die "the groomer writes to the card; it needs a Feature Board ticket" ;;
      --force-pull) FORCE_PULL=1; shift ;;
      --force-run) FORCE_RUN=1; shift ;;
      --verify) VERIFY=1; shift ;;
      --guidelines) [ $# -ge 2 ] || die "--guidelines needs a path"; GUIDELINES=$2; shift 2 ;;
      --repo) [ $# -ge 2 ] || die "--repo needs a path"; REPO=$2; shift 2 ;;
      --output) [ $# -ge 2 ] || die "--output needs a path"; OUT=$2; shift 2 ;;
      --finish) FINISH=1; shift ;;
      --take-recommended) TAKE_RECOMMENDED=1; shift ;;
      --parent-run) [ $# -ge 2 ] || die "--parent-run needs <run-id>:<nonce>"; PARENT_RUN=$2; shift 2 ;;
      --attach) [ $# -ge 2 ] || die "--attach needs the telemetry attach result as JSON"; ATTACH=$2; shift 2 ;;
      -*) die "unknown option: $1" ;;
      *) [ -z "$POSITIONAL" ] || die "one ticket at a time"; POSITIONAL=${1#@}; shift ;;
    esac
  done
  check_parent_run
  REPO=$(git -C "${REPO:-$PWD}" rev-parse --show-toplevel) || die "run inside a Git repo or pass --repo"
  [ -z "$GUIDELINES" ] || GUIDELINES=$(absolute_file "$GUIDELINES")
  if [ -n "$POSITIONAL" ] && [ -e "$POSITIONAL" ]; then
    die "$POSITIONAL is a file path, not a ticket; the groomer writes to the card and needs a Feature Board ticket"
  fi
  [ -z "$OUT" ] || [[ $OUT = /* ]] || OUT="$PWD/$OUT"
}
# The Feature Board URL from the repository's aspira.json, for the BOARD-010 hint.
board_url() { sed -nE 's/.*"board"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$REPO/aspira.json" 2>/dev/null | head -n 1; }
# The board step before a separate-process run: resolve the ticket, check its Type and Status (a refusal
# exits 3 before anything is launched), pull its pages into .work/<id>-<slug>/ (Grooming Decisions
# included), put this run's marker on that page and make the start move. A board the integration
# cannot read gets the BOARD-010 hint. Reads the key=value lines of scripts/ticket.ts into T_FOLDER,
# T_ID, T_TITLE, T_URL, T_BEFORE, T_STATUS, T_INPUT, and the run id and start time finish takes back
# into T_RUN_ID and T_RUN_STARTED (none with --parent-run).
ticket_start() {
  local out err code=0 line key value board
  out=$(mktemp "${TMPDIR:-/tmp}/groomer-ticket.XXXXXX")
  err=$(mktemp "${TMPDIR:-/tmp}/groomer-ticket-err.XXXXXX")
  agent_node scripts/ticket.ts start "$POSITIONAL" --repo "$REPO" ${FORCE_PULL:+--force-pull} ${FORCE_RUN:+--force-run} ${PARENT_RUN:+--parent-run "$PARENT_RUN"} > "$out" 2> "$err" || code=$?
  cat "$err" >&2
  if [ "$code" != 0 ]; then
    if grep -Eq 'Notion [0-9]{3} \(' "$err"; then
      board=$(board_url)
      echo "Board: ${board:-<no board in $REPO/aspira.json>}; check BOARD-010 (the aspira-agents connection on the product teamspace)" >&2
    fi
    rm -f "$out" "$err"; exit "$code"
  fi
  rm -f "$err"
  T_FOLDER="" T_ID="" T_TITLE="" T_URL="" T_BEFORE="" T_STATUS="" T_INPUT=""
  while IFS= read -r line; do
    key=${line%%=*}; value=${line#*=}
    case $key in
      folder) T_FOLDER=$value ;; id) T_ID=$value ;; title) T_TITLE=$value ;; url) T_URL=$value ;;
      before) T_BEFORE=$value ;; status) T_STATUS=$value ;; input) T_INPUT=$value ;;
      run-id) T_RUN_ID=$value ;; run-started) T_RUN_STARTED=$value ;;
    esac
  done < "$out"
  rm -f "$out"
  [ -n "$T_FOLDER" ] || die "the ticket step printed no working folder"
}
cmd_start() {
  parse "$@"
  [ -z "$FINISH" ] || die "--finish only applies to local"
  [ -z "$VERIFY" ] || die "--verify only applies to local"
  [ -z "$TAKE_RECOMMENDED" ] || die "--take-recommended only applies to local"
  [ -z "$ATTACH" ] || die "--attach only applies to local --verify"
  [ -z "$OUT" ] || die "--output: the groomer always writes to .work/<id>-<slug>/groom, where its finish step reads the record"
  local run prompt eve="" folder="" idea
  resolve_agent
  node_args
  command -v node >/dev/null || die "node is not installed"
  command -v screen >/dev/null || die "screen is not installed"
  [ -e "$PROJECT/.env.local" ] || [ -e "$AGENT/.env.local" ] || [ -n "${AI_GATEWAY_API_KEY:-}" ] || die "missing $PROJECT/.env.local (or the agent's .env.local) or AI_GATEWAY_API_KEY"
  ticket_start
  folder=$T_FOLDER
  idea=${T_INPUT:-"$folder/idea.md"}
  [ -f "$idea" ] || die "$T_ID has no idea.md in its working folder (expected $folder/idea.md); the pull writes it from the ticket's Idea"
  OUT="$folder/groom"
  printf 'ticket: %s %s (%s)\nstatus: %s -> %s\nfolder: %s\n' "$T_ID" "$T_TITLE" "$T_URL" "$T_BEFORE" "$T_STATUS" "$folder"
  [ -n "$GUIDELINES" ] || eve=$(eve_bin)
  run=$(mktemp -d "${TMPDIR:-/tmp}/groomer.XXXXXX")
  prompt="Groom the Feature Board ticket $T_ID in the working folder $folder for the local repository $REPO. Use load-knowledge for the required guidelines, then call groom once with the folder, the repository and the guidelines path. The ticket's board moves, the Grooming Decisions page and the Idea summary are written by the launcher around this run; do not move the card or write Notion yourself. Report the run status, the questions of the round, $OUT/trace/groom.json and $OUT/run-analysis.md."
  printf '%s\n' "$OUT" > "$run/output"
  printf '%s\n' "$AGENT/agent/instructions.md" > "$run/instructions"
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
  node "${NODE_ARGS[@]}" "$AGENT/scripts/groom.ts" "$FOLDER" "$REPO" "$GUIDELINES" > "$RUN/log" 2>&1
else
  node "${NODE_ARGS[@]}" "$EVE" invoke "$PROMPT" > "$RUN/log" 2>&1
fi
code=$?
printf '%s\n' "$code" > "$RUN/exit"
# The trace records which agent package ran.
[ ! -d "$OUTPUT/trace" ] || cp "$RUN/agent.json" "$OUTPUT/trace/agent-version.json"
# The board step after the run: the ticks merged, Grooming Decisions replaced, on a confirm the Idea
# summary and the Shortlist move. The run status is the one groom.json records; the finish step is the
# one writer of the final word, which it prints first as run-status=<word>.
status=$(node -p "try { JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).status ?? 'incomplete' } catch { 'incomplete' }" "$OUTPUT/trace/groom.json" 2>/dev/null || echo incomplete)
case $status in needs-author|confirmed|stopped) outcome=--ok ;; *) outcome=--failed ;; esac
# The run's telemetry (KIT-19): the run id and start time ticket.ts start printed, or the build-feature
# step this run is (--parent-run), which writes none of its own.
telemetry=()
[ -z "$RUN_ID" ] || telemetry+=(--run-id "$RUN_ID" --run-started "$RUN_STARTED")
[ -z "$PARENT_RUN" ] || telemetry+=(--parent-run "$PARENT_RUN")
finish=$(node "${NODE_ARGS[@]}" "$AGENT/scripts/ticket.ts" finish --repo "$REPO" --folder "$FOLDER" "$outcome" --run-status "$status" --export "$OUTPUT" ${telemetry[@]+"${telemetry[@]}"} 2>&1)
printf '%s\n' "$finish" >> "$RUN/log"
recorded=$(printf '%s\n' "$finish" | sed -n 's/^run-status=//p' | head -n 1)
printf '%s\n' "${recorded:-$status}" > "$RUN/status"
RUNNER
  chmod +x "$run/run.sh"
  AGENT="$AGENT" EVE="$eve" REPO="$REPO" GUIDELINES="$GUIDELINES" OUTPUT="$OUT" PROMPT="$prompt" RUN="$run" FOLDER="$folder" GROOMER_REPO="$REPO" GROOMER_FOLDER="$folder" RUN_ID="$T_RUN_ID" RUN_STARTED="$T_RUN_STARTED" PARENT_RUN="$PARENT_RUN" screen -dmS "groomer-$(basename "$run")" "$run/run.sh"
  printf 'started\nrun: %s\nidea: %s\nrepo: %s\noutput: %s\ninstructions: %s\n' "$run" "$idea" "$REPO" "$OUT" "$AGENT/agent/instructions.md"
  agent_line
}
# One synchronous step of a --local run: no model calls here, so no screen, gateway key or wait.
# The driver prints the board stage first (the ticket's resolve, pull, marker and start move for the
# session to perform), then knowledge, then each round's stages (round, answers, summary on a
# confirm, board); --verify follows every board stage.
cmd_local() {
  parse "$@"
  [ -z "$OUT" ] || die "--output: the groomer always writes to .work/<id>-<slug>/groom"
  command -v node >/dev/null || die "node is not installed"
  local args=(--repo "$REPO")
  [ -z "$POSITIONAL" ] || args+=(--ticket "$POSITIONAL")
  [ -z "$GUIDELINES" ] || args+=(--guidelines "$GUIDELINES")
  [ -z "$FORCE_PULL" ] || args+=(--force-pull)
  [ -z "$FORCE_RUN" ] || args+=(--force-run)
  [ -z "$VERIFY" ] || args+=(--verify)
  [ -z "$FINISH" ] || args+=(--finish)
  [ -z "$PARENT_RUN" ] || args+=(--parent-run "$PARENT_RUN")
  [ -z "$ATTACH" ] || args+=(--attach "$ATTACH")
  [ -z "$TAKE_RECOMMENDED" ] || args+=(--take-recommended)
  resolve_agent
  agent_node scripts/local.ts "${args[@]}"
}
# The run status, the page and the open questions, from <output>/trace/groom.json (the finish step
# writes the final word there); the record is missing until the run writes it.
groom_lines() {
  local record=$1/trace/groom.json
  if [ ! -f "$record" ]; then
    echo 'Status: not yet written (run in progress or stopped before its first round)'
    return
  fi
  node -e '
    let record = {}
    try { record = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")) } catch {}
    console.log(`Status: ${record.status ?? "unknown"}`)
    console.log(`Grooming Decisions: ${record.page?.url || "not created yet"}`)
    console.log(`Open questions: ${record.open ?? 0}`)
  ' "$record"
}
cmd_status() {
  local run=${1:?usage: groomer.sh status RUN} elapsed output
  [ -f "$run/started" ] || die "not a run directory: $run"
  elapsed=$(( $(date +%s) - $(cat "$run/started") ))
  output=$(cat "$run/output")
  if [ ! -f "$run/exit" ]; then
    printf 'running (%ss)\nlog: %s/log\n' "$elapsed" "$run"
    [ ! -f "$run/agent" ] || cat "$run/agent"
    [ ! -f "$run/log" ] || tail -n 3 "$run/log"
  else
    printf 'finished (%ss), exit %s\noutput: %s\n' "$elapsed" "$(cat "$run/exit")" "$output"
    [ ! -f "$run/agent" ] || cat "$run/agent"
    tail -n 40 "$run/log"
    [ ! -f "$run/instructions" ] || printf 'Instructions: %s\n' "$(cat "$run/instructions")"
  fi
  groom_lines "$output"
  printf 'Decisions: %s/trace/decisions.md\nRun analysis: %s/run-analysis.md\n' "$output" "$output"
}
cmd_wait() {
  local run=${1:?usage: groomer.sh wait RUN [--max SECONDS]} max=30 deadline
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
  *) die "usage: groomer.sh start [TICKET] [--force-pull] [--force-run] [--guidelines FILE] [--repo DIR] [--parent-run RUN:NONCE] | status RUN | wait RUN [--max SECONDS] | local [TICKET] [--force-pull] [--force-run] [--verify] [--guidelines FILE] [--repo DIR] [--finish] [--take-recommended] [--parent-run RUN:NONCE] [--attach JSON]" ;;
esac
