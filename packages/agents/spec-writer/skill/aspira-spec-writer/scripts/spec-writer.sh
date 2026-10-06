#!/bin/bash
# Launch the official spec writer without keeping the caller's tool invocation open (start/status/wait),
# or step a --local run whose model work runs in the calling Claude Code session (local).
set -euo pipefail

NAME=spec-writer
PKG=@aspiralabs/spec-writer
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
# Which spec-writer runs, in this order: SPEC_WRITER_AGENT_DIR (kit development only; the report says so),
# the @aspiralabs/spec-writer installed under the project (walking up from the working directory, then
# from this script's location), then this script's own package. $ASPIRA_KIT is never consulted.
# Sets AGENT, AGENT_SOURCE (env | installed | package), AGENT_VERSION and PROJECT.
resolve_agent() {
  local here dir
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  AGENT="" AGENT_SOURCE="" PROJECT=""
  for dir in "${SPEC_WRITER_AGENT_DIR:-}"; do
    [ -n "$dir" ] || continue
    is_agent "$dir" || die "SPEC_WRITER_AGENT_DIR is not the $PKG package: $dir"
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
  [ -n "$AGENT" ] || die "cannot find $PKG: install @aspiralabs/agents in the project (kit init), or set SPEC_WRITER_AGENT_DIR for kit development"
  [ -n "$PROJECT" ] || PROJECT=$(project_root)
  AGENT_VERSION=$(sed -nE 's/^ *"version": *"([^"]+)".*/\1/p' "$AGENT/package.json" | head -n 1)
  case $AGENT_SOURCE:$AGENT in
    env:*) echo "$NAME: SPEC_WRITER_AGENT_DIR is set: running kit source at $AGENT, not the installed $PKG" >&2 ;;
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
# The ticket argument (F1 of the ticket flow): a board ID such as NOM-4, a Notion page URL, nothing
# (the one folder under .work/ that holds a ticket.md), or a spec path with --no-ticket. Sets
# POSITIONAL, NO_TICKET, FORCE_PULL, VERIFY, GUIDELINES, REPO, OUT, FINISH and, with --no-ticket, SPEC.
parse() {
  POSITIONAL="" NO_TICKET="" FORCE_PULL="" VERIFY="" GUIDELINES="" REPO="" OUT="" FINISH="" SPEC=""
  while [ $# -gt 0 ]; do
    case $1 in
      --no-ticket) NO_TICKET=1; shift ;;
      --force-pull) FORCE_PULL=1; shift ;;
      --verify) VERIFY=1; shift ;;
      --guidelines) [ $# -ge 2 ] || die "--guidelines needs a path"; GUIDELINES=$2; shift 2 ;;
      --repo) [ $# -ge 2 ] || die "--repo needs a path"; REPO=$2; shift 2 ;;
      --output) [ $# -ge 2 ] || die "--output needs a path"; OUT=$2; shift 2 ;;
      --finish) FINISH=1; shift ;;
      -*) die "unknown option: $1" ;;
      *) [ -z "$POSITIONAL" ] || die "one ticket at a time (or one spec with --no-ticket)"; POSITIONAL=${1#@}; shift ;;
    esac
  done
  REPO=$(git -C "${REPO:-$PWD}" rev-parse --show-toplevel) || die "run inside a Git repo or pass --repo"
  [ -z "$GUIDELINES" ] || GUIDELINES=$(absolute_file "$GUIDELINES")
  if [ -n "$NO_TICKET" ]; then
    [ -n "$POSITIONAL" ] || die "--no-ticket runs the spec-writer on an idea path with no board: spec-writer.sh start|local <idea.md> --no-ticket"
    SPEC=$(absolute_file "$POSITIONAL")
    OUT=${OUT:-"$(dirname "$SPEC")/spec.written"}
  elif [ -n "$POSITIONAL" ] && [ -e "$POSITIONAL" ]; then
    die "$POSITIONAL is a file path, not a ticket; pass --no-ticket to run on a path with no board"
  fi
  [ -z "$OUT" ] || [[ $OUT = /* ]] || OUT="$PWD/$OUT"
}
# The board step before a separate-process run: resolve the ticket, check its Status (a refusal exits 3
# before anything is launched), pull its pages into .work/<id>-<slug>/ and claim it. Reads the key=value
# lines of scripts/ticket.ts into T_FOLDER, T_ID, T_TITLE, T_URL, T_BEFORE, T_STATUS, T_INPUT.
ticket_start() {
  local out code line key value
  out=$(mktemp "${TMPDIR:-/tmp}/spec-writer-ticket.XXXXXX")
  agent_node scripts/ticket.ts start "$POSITIONAL" --repo "$REPO" ${FORCE_PULL:+--force-pull} > "$out"; code=$?
  if [ "$code" != 0 ]; then rm -f "$out"; exit "$code"; fi
  T_FOLDER="" T_ID="" T_TITLE="" T_URL="" T_BEFORE="" T_STATUS="" T_INPUT=""
  while IFS= read -r line; do
    key=${line%%=*}; value=${line#*=}
    case $key in
      folder) T_FOLDER=$value ;; id) T_ID=$value ;; title) T_TITLE=$value ;; url) T_URL=$value ;;
      before) T_BEFORE=$value ;; status) T_STATUS=$value ;; input) T_INPUT=$value ;;
    esac
  done < "$out"
  rm -f "$out"
  [ -n "$T_FOLDER" ] || die "the ticket step printed no working folder"
}
cmd_start() {
  parse "$@"
  [ -z "$FINISH" ] || die "--finish only applies to local"
  [ -z "$VERIFY" ] || die "--verify only applies to local"
  local run prompt eve="" folder="" spec
  resolve_agent
  node_args
  command -v node >/dev/null || die "node is not installed"
  command -v screen >/dev/null || die "screen is not installed"
  [ -e "$PROJECT/.env.local" ] || [ -e "$AGENT/.env.local" ] || [ -n "${AI_GATEWAY_API_KEY:-}" ] || die "missing $PROJECT/.env.local (or the agent's .env.local) or AI_GATEWAY_API_KEY"
  if [ -n "$NO_TICKET" ]; then
    spec=$SPEC
  else
    ticket_start
    folder=$T_FOLDER
    spec=$T_INPUT
    [ -n "$spec" ] && [ -f "$spec" ] || die "$T_ID has no idea.md in its working folder (expected $folder/idea.md); the pull writes it from the ticket's Idea"
    OUT=${OUT:-"$folder/spec.written"}
    printf 'ticket: %s %s (%s)\nstatus: %s -> %s\nfolder: %s\n' "$T_ID" "$T_TITLE" "$T_URL" "$T_BEFORE" "$T_STATUS" "$folder"
  fi
  [ -n "$GUIDELINES" ] || eve=$(eve_bin)
  run=$(mktemp -d "${TMPDIR:-/tmp}/spec-writer.XXXXXX")
  prompt="Write a spec from the idea at $spec for the local repository $REPO. Write results directly to $OUT. Use load-knowledge for the required guidelines, then call write-spec once. The ticket's board moves and pushes are made by the launcher around this run; do not call board yourself. Report status, spec.md, spec.draft.md, run-analysis.md and open author decisions."
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
  node "${NODE_ARGS[@]}" "$AGENT/scripts/write.ts" "$SPEC" "$REPO" "$GUIDELINES" "$OUTPUT" > "$RUN/log" 2>&1
else
  node "${NODE_ARGS[@]}" "$EVE" invoke "$PROMPT" > "$RUN/log" 2>&1
fi
code=$?
printf '%s\n' "$code" > "$RUN/exit"
# The trace records which agent package ran.
[ ! -d "$OUTPUT/trace" ] || cp "$RUN/agent.json" "$OUTPUT/trace/agent-version.json"
# The board step after the run: the written spec becomes the folder's spec.md, pushed as the Spec page, then the success move.
if [ -n "$FOLDER" ]; then
  [ ! -f "$OUTPUT/spec.md" ] || cp "$OUTPUT/spec.md" "$FOLDER/spec.md"
  status=$(node -p "try { JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).status ?? 'incomplete' } catch { 'incomplete' }" "$OUTPUT/trace/review.json" 2>/dev/null || echo incomplete)
  case $status in ready|needs-author) outcome=--ok ;; *) outcome=--failed ;; esac
  [ -f "$FOLDER/spec.md" ] || outcome=--failed
  node "${NODE_ARGS[@]}" "$AGENT/scripts/ticket.ts" finish --repo "$REPO" --folder "$FOLDER" "$outcome" --run-status "$status" --export "$OUTPUT" >> "$RUN/log" 2>&1
fi
RUNNER
  chmod +x "$run/run.sh"
  AGENT="$AGENT" EVE="$eve" SPEC="$spec" REPO="$REPO" GUIDELINES="$GUIDELINES" OUTPUT="$OUT" PROMPT="$prompt" RUN="$run" FOLDER="$folder" screen -dmS "spec-writer-$(basename "$run")" "$run/run.sh"
  printf 'started\nrun: %s\nidea: %s\nrepo: %s\noutput: %s\ninstructions: %s\n' "$run" "$spec" "$REPO" "$OUT" "$AGENT/agent/instructions.md"
  agent_line
}
# One synchronous step of a --local run: no model calls here, so no screen, gateway key or wait.
# The driver prints the board stage first (the ticket's resolve, pull and claim for the session to
# perform), then knowledge and the pending phases, then the finished report with the end board actions;
# --verify is the last step, once the session made the moves.
cmd_local() {
  parse "$@"
  command -v node >/dev/null || die "node is not installed"
  local args=(--repo "$REPO")
  if [ -n "$NO_TICKET" ]; then args+=(--no-ticket "$SPEC"); elif [ -n "$POSITIONAL" ]; then args+=(--ticket "$POSITIONAL"); fi
  [ -z "$OUT" ] || args+=(--output "$OUT")
  [ -z "$GUIDELINES" ] || args+=(--guidelines "$GUIDELINES")
  [ -z "$FORCE_PULL" ] || args+=(--force-pull)
  [ -z "$VERIFY" ] || args+=(--verify)
  [ -z "$FINISH" ] || args+=(--finish)
  resolve_agent
  agent_node scripts/local.ts "${args[@]}"
}
cmd_status() {
  local run=${1:?usage: spec-writer.sh status RUN} elapsed output
  [ -f "$run/started" ] || die "not a run directory: $run"
  elapsed=$(( $(date +%s) - $(cat "$run/started") ))
  if [ ! -f "$run/exit" ]; then
    printf 'running (%ss)\nlog: %s/log\n' "$elapsed" "$run"
    [ ! -f "$run/log" ] || tail -n 3 "$run/log"
    return
  fi
  output=$(cat "$run/output")
  printf 'finished (%ss), exit %s\noutput: %s\n' "$elapsed" "$(cat "$run/exit")" "$output"
  [ ! -f "$run/agent" ] || cat "$run/agent"
  tail -n 40 "$run/log"
  [ ! -f "$run/instructions" ] || printf 'Instructions: %s\n' "$(cat "$run/instructions")"
  printf 'Spec: %s/spec.md (only if the review produced valid edits)\nDraft: %s/spec.draft.md\nDecisions: %s/trace/decisions.md\nRun analysis: %s/run-analysis.md\n' "$output" "$output" "$output" "$output"
}
cmd_wait() {
  local run=${1:?usage: spec-writer.sh wait RUN [--max SECONDS]} max=30 deadline
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
  *) die "usage: spec-writer.sh start [TICKET | IDEA --no-ticket] [--force-pull] [--guidelines FILE] [--repo DIR] [--output DIR] | status RUN | wait RUN [--max SECONDS] | local [TICKET | IDEA --no-ticket] [--force-pull] [--verify] [--guidelines FILE] [--repo DIR] [--output DIR] [--finish]" ;;
esac
