#!/bin/bash
# Launch the official spec writer without keeping the caller's tool invocation open (start/status/wait),
# or step a --local run whose model work runs in the calling Claude Code session (local).
set -euo pipefail

NAME=spec-writer
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
# Which NAME runs, in this order: SPEC_WRITER_AGENT_DIR (kit development only; the report says so), then
# the global @aspiralabs/ai (`kit package-dir`, the kit found by find_kit). A project's own node_modules copy and $ASPIRA_KIT are never consulted.
# Sets AGENT, AGENT_SOURCE (env | global), AGENT_VERSION and PROJECT.
resolve_agent() {
  local here dir pinned="" current
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  # The skill's pin, read before the kit runs: `kit package-dir` rewrites a stale global skill.
  [ ! -f "$here/../.kit-version" ] || pinned=$(tr -d '[:space:]' < "$here/../.kit-version")
  AGENT="" AGENT_SOURCE="" PROJECT=""
  for dir in "${SPEC_WRITER_AGENT_DIR:-}"; do
    [ -n "$dir" ] || continue
    is_agent "$dir" || die "SPEC_WRITER_AGENT_DIR is not the $NAME folder of @aspiralabs/ai: $dir"
    AGENT=$(cd "$dir" && pwd -P); AGENT_SOURCE=env; break
  done
  if [ -z "$AGENT" ] && AGENT=$(global_install); then AGENT_SOURCE=global; fi
  [ -n "$AGENT" ] || die "cannot find $NAME: install @aspiralabs/ai globally (pnpm add -g @aspiralabs/ai) and run kit update; if it is installed, add pnpm's global bin to PATH (export PATH=\"\$HOME/Library/pnpm:\$PATH\" in your shell profile) and restart Claude Code; or set SPEC_WRITER_AGENT_DIR for kit development"
  PROJECT=$(project_root)
  AGENT_VERSION=$(sed -nE 's/^ *"version": *"([^"]+)".*/\1/p' "$AGENT/../package.json" | head -n 1)
  case $AGENT_SOURCE:$AGENT in
    env:*) echo "$NAME: SPEC_WRITER_AGENT_DIR is set: running kit source at $AGENT, not the installed @aspiralabs/ai" >&2 ;;
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
json_string() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
# true when the agent runs from an installed package. A function, not an inline `$(case …)`: bash 3.2
# (macOS /bin/bash) mis-parses the pattern's `)` inside a command substitution and reports a syntax error.
agent_installed() { case $AGENT in */node_modules/*) echo true ;; *) echo false ;; esac; }
agent_json() { printf '{"name":"%s","version":"%s","path":"%s","source":"%s","installed":%s}\n' "$NAME" "$(json_string "$AGENT_VERSION")" "$(json_string "$AGENT")" "$AGENT_SOURCE" "$(agent_installed)"; }
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
agent_node() {  # agent_node SCRIPT ARG...: run an agent script with node, from the agent directory
  local script=$1; shift
  node_args
  (cd "$AGENT" && exec node "${NODE_ARGS[@]}" "$AGENT/$script" "$@")
}
eve_bin() { find_up_module "$AGENT" eve/bin/eve.js || die "eve is not installed beside $AGENT; reinstall @aspiralabs/ai"; }
# Prints "Run status: <status>" and, when the record carries one, its reason line, for the run
# record at RECORD_FILE (RUN's saved repo and agent.json/node-args give ticket.ts record what it
# needs): scripts/ticket.ts record maps the record's status word (old or new alike) onto one of the
# five run statuses and this prints the record's own reason text first (F5, F7). Sets REPORT_EXIT
# to the status's exit code (run-status.ts's exitCodeFor: 0 ready, 1 incomplete or blocked, 3 refused,
# 5 needs-author), which the caller reports as its own.
report_record() {
  local record_file=$1 out status reason rc=0
  resolve_agent
  node_args
  out=$( (cd "$AGENT" && node "${NODE_ARGS[@]}" "$AGENT/scripts/ticket.ts" record --repo "$PROJECT" --file "$record_file") ) || rc=$?
  status=$(printf '%s
' "$out" | sed -n 's/^status=//p' | head -n 1)
  [ -n "$status" ] || status=incomplete
  reason=$(node -p "try { JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).reason || '' } catch { '' }" "$record_file" 2>/dev/null)
  printf 'Run status: %s
' "$status"
  [ -z "$reason" ] || printf '%s
' "$reason"
  REPORT_EXIT=$rc
}
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
# The ticket argument (F1 of the ticket flow): a board ID such as NOM-4, a Notion page URL, nothing
# (the one folder under .work/ that holds a ticket.md), or a spec path with --no-ticket. Sets
# POSITIONAL, NO_TICKET, FORCE_PULL, VERIFY, GUIDELINES, REPO, OUT, FINISH, TAKE_RECOMMENDED, PARENT_RUN,
# ATTACH (the --local verify step's telemetry attach result) and,
# with --no-ticket, SPEC.
parse() {
  LOCAL_FLAG="" CLOUD_FLAG="" POSITIONAL="" NO_TICKET="" FORCE_PULL="" VERIFY="" GUIDELINES="" PACKET="" REPO="" OUT="" FINISH="" TAKE_RECOMMENDED="" SPEC="" PARENT_RUN="" ATTACH="" T_RUN_ID="" T_RUN_STARTED=""
  while [ $# -gt 0 ]; do
    case $1 in
      --no-ticket) NO_TICKET=1; shift ;;
      --force-pull) FORCE_PULL=1; shift ;;
      --verify) VERIFY=1; shift ;;
      --guidelines) [ $# -ge 2 ] || die "--guidelines needs a path"; GUIDELINES=$2; shift 2 ;;
      --packet) [ $# -ge 2 ] || die "--packet needs a path"; PACKET=$2; shift 2 ;;
      --repo) [ $# -ge 2 ] || die "--repo needs a path"; REPO=$2; shift 2 ;;
      --output) [ $# -ge 2 ] || die "--output needs a path"; OUT=$2; shift 2 ;;
      --finish) FINISH=1; shift ;;
      --take-recommended) TAKE_RECOMMENDED=1; shift ;;
      --parent-run) [ $# -ge 2 ] || die "--parent-run needs <run-id>:<nonce>"; PARENT_RUN=$2; shift 2 ;;
      --local) LOCAL_FLAG=1; shift ;;
      --cloud) CLOUD_FLAG=1; shift ;;
      --attach) [ $# -ge 2 ] || die "--attach needs the telemetry attach result as JSON"; ATTACH=$2; shift 2 ;;
      -*) die "unknown option: $1" ;;
      *) [ -z "$POSITIONAL" ] || die "one ticket at a time (or one spec with --no-ticket)"; POSITIONAL=${1#@}; shift ;;
    esac
  done
  check_parent_run
  [ -z "$PARENT_RUN" ] || [ -z "$NO_TICKET" ] || die "--parent-run names a step of a build-feature run on a ticket; it does not go with --no-ticket"
  REPO=$(git -C "${REPO:-$PWD}" rev-parse --show-toplevel) || die "run inside a Git repo or pass --repo"
  [ -z "$GUIDELINES" ] || GUIDELINES=$(absolute_file "$GUIDELINES")
  if [ -n "$NO_TICKET" ]; then
    [ -n "$POSITIONAL" ] || die "--no-ticket runs the spec-writer on an idea path with no board: spec-writer.sh start|local <idea.md> --no-ticket"
    SPEC=$(absolute_file "$POSITIONAL")
    OUT=${OUT:-"$(dirname "$SPEC")/spec.reviewed"}
  elif [ -n "$POSITIONAL" ] && [ -e "$POSITIONAL" ]; then
    die "$POSITIONAL is a file path, not a ticket; pass --no-ticket to run on a path with no board"
  fi
  [ -z "$OUT" ] || [[ $OUT = /* ]] || OUT="$PWD/$OUT"
}
# The board step before a separate-process run: resolve the ticket, check its Status (a refusal exits 3
# before anything is launched), pull its pages into .work/<id>-<slug>/ and claim it. Reads the key=value
# lines of scripts/ticket.ts into T_FOLDER, T_ID, T_TITLE, T_URL, T_BEFORE, T_STATUS, T_INPUT,
# and the run id and start time finish takes back into T_RUN_ID and T_RUN_STARTED (none with --parent-run).
ticket_start() {
  local out code line key value
  out=$(mktemp "${TMPDIR:-/tmp}/spec-writer-ticket.XXXXXX")
  agent_node scripts/ticket.ts start "$POSITIONAL" --repo "$REPO" ${FORCE_PULL:+--force-pull} ${PARENT_RUN:+--parent-run "$PARENT_RUN"} > "$out"; code=$?
  if [ "$code" != 0 ]; then rm -f "$out"; exit "$code"; fi
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
  [ -z "$LOCAL_FLAG" ] || die "--local runs in this session: use the local command, not start"
  [ -z "$FINISH" ] || die "--finish only applies to local"
  [ -z "$VERIFY" ] || die "--verify only applies to local"
  [ -z "$TAKE_RECOMMENDED" ] || die "--take-recommended only applies to local"
  [ -z "$ATTACH" ] || die "--attach only applies to local --verify"
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
    [ -n "$spec" ] && [ -f "$spec" ] || die "$T_ID has no input in its working folder (idea.md from the ticket's Idea, or the spec to review again from In Review: Spec)"
    OUT=${OUT:-"$folder/spec.reviewed"}
    printf 'ticket: %s %s (%s)\nstatus: %s -> %s\nfolder: %s\n' "$T_ID" "$T_TITLE" "$T_URL" "$T_BEFORE" "$T_STATUS" "$folder"
  fi
  [ -n "$GUIDELINES" ] || eve=$(eve_bin)
  run=$(mktemp -d "${TMPDIR:-/tmp}/spec-writer.XXXXXX")
  case $(basename "$spec") in
    spec.md|spec.reviewed.md) prompt="Review the answered spec at $spec again for the local repository $REPO (the one spec step, rerun from In Review: Spec): call write-spec once with specPath, never ideaPath. Write results directly to $OUT. Use load-knowledge for the required guidelines first. The ticket's board pushes are made by the launcher around this run; do not call board yourself. Report status, spec.reviewed.md, run-analysis.md and open author decisions." ;;
    *) prompt="Write a spec from the idea at $spec for the local repository $REPO. Write results directly to $OUT. Use load-knowledge for the required guidelines, then call write-spec once with ideaPath. The ticket's board moves and pushes are made by the launcher around this run; do not call board yourself. Report status, spec.reviewed.md, spec.draft.md, run-analysis.md and open author decisions." ;;
  esac
  printf '%s\n' "$OUT" > "$run/output"
  printf '%s\n' "$REPO" > "$run/repo"
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
# The board step after the run: the reviewed spec becomes the folder's spec.md (the Spec page) and is pushed as Spec Reviewed, then the success move (none from In Review: Spec).
if [ -n "$FOLDER" ]; then
  [ ! -f "$OUTPUT/spec.reviewed.md" ] || cp "$OUTPUT/spec.reviewed.md" "$FOLDER/spec.md"
  status=$(node -p "try { JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).status ?? 'incomplete' } catch { 'incomplete' }" "$OUTPUT/trace/review.json" 2>/dev/null || echo incomplete)
  # The run's telemetry (KIT-19): the run id and start time ticket.ts start printed, or the build-feature
  # step this run is (--parent-run), which writes none of its own.
  telemetry=()
  [ -z "$RUN_ID" ] || telemetry+=(--run-id "$RUN_ID" --run-started "$RUN_STARTED")
  [ -z "$PARENT_RUN" ] || telemetry+=(--parent-run "$PARENT_RUN")
  node "${NODE_ARGS[@]}" "$AGENT/scripts/ticket.ts" finish --repo "$REPO" --folder "$FOLDER" --run-status "$status" --export "$OUTPUT" ${telemetry[@]+"${telemetry[@]}"} >> "$RUN/log" 2>&1
fi
RUNNER
  chmod +x "$run/run.sh"
  AGENT="$AGENT" EVE="$eve" SPEC="$spec" REPO="$REPO" GUIDELINES="$GUIDELINES" OUTPUT="$OUT" PROMPT="$prompt" RUN="$run" FOLDER="$folder" RUN_ID="$T_RUN_ID" RUN_STARTED="$T_RUN_STARTED" PARENT_RUN="$PARENT_RUN" screen -dmS "spec-writer-$(basename "$run")" "$run/run.sh"
  printf 'started\nrun: %s\nidea: %s\nrepo: %s\noutput: %s\ninstructions: %s\n' "$run" "$spec" "$REPO" "$OUT" "$AGENT/agent/instructions.md"
  agent_line
}
# One synchronous step of a --local run: no model calls here, so no screen, gateway key or wait.
# The driver prints the board stage first (the ticket's resolve, pull and claim for the session to
# perform), then knowledge and the pending phases, then the finished report with the end board actions;
# --verify is the last step, once the session made the moves.
cmd_local() {
  parse "$@"
  [ -z "$CLOUD_FLAG" ] || die "--cloud runs the separate agent: use the start command, not local"
  command -v node >/dev/null || die "node is not installed"
  local args=(--repo "$REPO")
  if [ -n "$NO_TICKET" ]; then args+=(--no-ticket "$SPEC"); elif [ -n "$POSITIONAL" ]; then args+=(--ticket "$POSITIONAL"); fi
  [ -z "$OUT" ] || args+=(--output "$OUT")
  [ -z "$GUIDELINES" ] || args+=(--guidelines "$GUIDELINES")
  [ -z "$PACKET" ] || args+=(--packet "$PACKET")
  [ -z "$FORCE_PULL" ] || args+=(--force-pull)
  [ -z "$VERIFY" ] || args+=(--verify)
  [ -z "$FINISH" ] || args+=(--finish)
  [ -z "$PARENT_RUN" ] || args+=(--parent-run "$PARENT_RUN")
  [ -z "$ATTACH" ] || args+=(--attach "$ATTACH")
  [ -z "$TAKE_RECOMMENDED" ] || args+=(--take-recommended)
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
    exit 75
  fi
  output=$(cat "$run/output")
  report_record "$output/trace/review.json"
  printf 'finished (%ss), exit %s\noutput: %s\n' "$elapsed" "$(cat "$run/exit")" "$output"
  [ ! -f "$run/agent" ] || cat "$run/agent"
  [ ! -f "$run/log" ] || tail -n 40 "$run/log"
  [ ! -f "$run/instructions" ] || printf 'Instructions: %s\n' "$(cat "$run/instructions")"
  printf 'Spec: %s/spec.reviewed.md (only if the review produced valid edits)\nDraft: %s/spec.draft.md (write mode only)\nDecisions: %s/trace/decisions.md\nRun analysis: %s/run-analysis.md\n' "$output" "$output" "$output" "$output"
  exit "$REPORT_EXIT"
}
cmd_load_knowledge() {
  local out=""
  while [ $# -gt 0 ]; do
    case $1 in
      --out) [ $# -ge 2 ] || die "--out needs a directory"; out=$2; shift 2 ;;
      -*) die "unknown option: $1" ;;
      *) die "unknown argument: $1" ;;
    esac
  done
  [ -n "$out" ] || die "usage: spec-writer.sh load-knowledge --out DIR"
  resolve_agent
  node_args
  command -v node >/dev/null || die "node is not installed"
  local common
  common="$AGENT/../common"; [ -d "$common" ] || die "common is missing beside $AGENT; reinstall @aspiralabs/ai"
  node "${NODE_ARGS[@]}" "$common/scripts/load-knowledge.ts" --out "$out"
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
  load-knowledge) shift; cmd_load_knowledge "$@" ;;
  *) die "usage: spec-writer.sh start [TICKET | IDEA --no-ticket] [--force-pull] [--guidelines FILE] [--repo DIR] [--output DIR] [--parent-run RUN:NONCE] | status RUN | wait RUN [--max SECONDS] | local [TICKET | IDEA --no-ticket] [--force-pull] [--verify] [--guidelines FILE] [--repo DIR] [--output DIR] [--finish] [--take-recommended] [--parent-run RUN:NONCE] [--attach JSON] | load-knowledge --out DIR" ;;
esac
