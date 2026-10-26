#!/bin/bash
# Launch the implementor agent on a GitHub repository without keeping the caller's tool invocation
# open (start/status/wait), or step a --local build whose model work runs in the calling Claude Code
# session (local).
set -euo pipefail

NAME=implementor
die() { echo "$NAME: $*" >&2; exit 1; }
# The agent folder of @aspiralabs/ai: named $NAME, with skill/ and agent/, src/ or scripts/, under a
# package.json that names @aspiralabs/ai (recognised by path).
is_agent() {
  [ "$(basename "$1")" = "$NAME" ] && [ -d "$1/skill" ] && { [ -d "$1/agent" ] || [ -d "$1/src" ] || [ -d "$1/scripts" ]; } \
    && grep -qs '"name": "@aspiralabs/ai"' "$1/../package.json"
}
# The agent folder of the global @aspiralabs/ai (pnpm add -g), from the kit on PATH, which prints its own directory.
# `kit package-dir` also rewrites the global skills when they are behind the kit (self-healing).
global_install() {
  local pkg
  command -v kit >/dev/null 2>&1 || return 1
  pkg=$(kit package-dir 2>/dev/null) && [ -n "$pkg" ] || return 1
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
  die "no Aspira project here (no aspira.json at or above $PWD)"
}
# Which NAME runs, in this order: IMPLEMENTOR_AGENT_DIR (kit development only; the report says so), then
# the global @aspiralabs/ai on PATH (`kit package-dir`). A project's own node_modules copy and $ASPIRA_KIT are never consulted.
# Sets AGENT, AGENT_SOURCE (env | global), AGENT_VERSION and PROJECT.
resolve_agent() {
  local here dir pinned="" current
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  # The skill's pin, read before the kit runs: `kit package-dir` rewrites a stale global skill.
  [ ! -f "$here/../.kit-version" ] || pinned=$(tr -d '[:space:]' < "$here/../.kit-version")
  AGENT="" AGENT_SOURCE="" PROJECT=""
  for dir in "${IMPLEMENTOR_AGENT_DIR:-}"; do
    [ -n "$dir" ] || continue
    is_agent "$dir" || die "IMPLEMENTOR_AGENT_DIR is not the $NAME folder of @aspiralabs/ai: $dir"
    AGENT=$(cd "$dir" && pwd -P); AGENT_SOURCE=env; break
  done
  if [ -z "$AGENT" ] && AGENT=$(global_install); then AGENT_SOURCE=global; fi
  [ -n "$AGENT" ] || die "cannot find $NAME: install @aspiralabs/ai globally (pnpm add -g @aspiralabs/ai) and run kit update, or set IMPLEMENTOR_AGENT_DIR for kit development"
  PROJECT=$(project_root)
  AGENT_VERSION=$(sed -nE 's/^ *"version": *"([^"]+)".*/\1/p' "$AGENT/../package.json" | head -n 1)
  case $AGENT_SOURCE:$AGENT in
    env:*) echo "$NAME: IMPLEMENTOR_AGENT_DIR is set: running kit source at $AGENT, not the installed @aspiralabs/ai" >&2 ;;
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
  local file
  for file in "$PROJECT/.env.local" "$AGENT/.env.local" "$AGENT/.env.development.local"; do [ ! -f "$file" ] || NODE_ARGS+=("--env-file=$file"); done
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
absolute_path() {
  if [[ $1 = /* ]]; then printf '%s\n' "$1"; else printf '%s/%s\n' "$PWD" "$1"; fi
}
is_github() {
  [[ $1 =~ ^(https?://(www\.)?github\.com/|git@github\.com:)?[A-Za-z0-9_-][A-Za-z0-9_.-]*/[A-Za-z0-9_.-]+(\.git)?/?$ ]] && [ ! -d "$1" ]
}
SOURCE="" REPO="" REF="" PR="" LOCAL="" CLOUD="" GUIDELINES="" PARALLEL="" SERIAL="" WORK="" FINISH="" NO_TICKET="" FORCE_PULL="" VERIFY="" PR_URL="" REPLACE_PENDING="" PARENT_RUN="" ATTACH="" T_RUN_ID="" T_RUN_STARTED=""
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
# The first positional is the Feature Board ticket (an ID such as NOM-4, or a Notion page URL), or
# nothing (the one folder under .work/ with a ticket.md), or, with --no-ticket, the source path as before.
# --parent-run and --attach are as in the other launchers: a build-feature step, and the --local verify
# step's telemetry attach result.
parse() {
  while [ $# -gt 0 ]; do
    case $1 in
      --repo) [ $# -ge 2 ] || die "--repo needs a directory or owner/name"; REPO=$2; shift 2 ;;
      --ref) [ $# -ge 2 ] || die "--ref needs a branch"; REF=$2; shift 2 ;;
      --pr) PR=1; shift ;;
      --local) LOCAL=1; shift ;;
      --cloud) CLOUD=1; shift ;;
      --no-ticket) NO_TICKET=1; shift ;;
      --force-pull) FORCE_PULL=1; shift ;;
      --verify) VERIFY=1; shift ;;
      --pr-url) [ $# -ge 2 ] || die "--pr-url needs a GitHub pull request URL"; PR_URL=$2; shift 2 ;;
      --replace-pending) REPLACE_PENDING=1; shift ;;
      --guidelines) [ $# -ge 2 ] || die "--guidelines needs a file"; GUIDELINES=$(absolute_path "$2"); shift 2 ;;
      --max-parallel) [ $# -ge 2 ] || die "--max-parallel needs a number"; PARALLEL=$2; shift 2 ;;
      --serial) SERIAL=1; shift ;;
      --work) [ $# -ge 2 ] || die "--work needs a directory"; WORK=$(absolute_path "$2"); shift 2 ;;
      --finish) FINISH=1; shift ;;
      --parent-run) [ $# -ge 2 ] || die "--parent-run needs <run-id>:<nonce>"; PARENT_RUN=$2; shift 2 ;;
      --attach) [ $# -ge 2 ] || die "--attach needs the telemetry attach result as JSON"; ATTACH=$2; shift 2 ;;
      -*) die "unknown option: $1" ;;
      *) [ -z "$SOURCE" ] || die "one ticket at a time (or one source with --no-ticket)"; SOURCE=${1#@}; shift ;;
    esac
  done
  check_parent_run
  [ -z "$PARENT_RUN" ] || [ -z "$NO_TICKET" ] || die "--parent-run names a step of a build-feature run on a ticket; it does not go with --no-ticket"
  if [ -n "$PARALLEL" ]; then
    [[ $PARALLEL =~ ^[0-9]+$ ]] && [ "$PARALLEL" -ge 1 ] && [ "$PARALLEL" -le 16 ] || die "--max-parallel must be 1..16"
  fi
  if [ -n "$NO_TICKET" ]; then
    [ -n "$SOURCE" ] || die "--no-ticket runs the implementor on a source path with no board: implementor.sh start|local <plan.review | plan.reviewed.md | spec.md> --no-ticket"
  elif [ -n "$SOURCE" ] && [ -e "$SOURCE" ]; then
    die "$SOURCE is a file path, not a ticket; pass --no-ticket to run on a path with no board"
  fi
}
# The repository root for the board step: the git top of --repo (a directory) or the working directory.
repo_top() {
  local dir=${REPO:-$PWD}
  git -C "$dir" rev-parse --show-toplevel 2>/dev/null || printf '%s\n' "$(cd "$dir" && pwd -P)"
}
# The board step before a separate-process run: resolve the ticket, check its Status (a refusal exits 3
# before anything is launched), pull its pages into .work/<id>-<slug>/ and claim it. Reads the key=value
# lines of scripts/ticket.ts into T_FOLDER, T_ID, T_TITLE, T_URL, T_BEFORE, T_STATUS, T_INPUT,
# and the run id and start time finish takes back into T_RUN_ID and T_RUN_STARTED (none with --parent-run).
ticket_start() {
  local top=$1 out code line key value
  out=$(mktemp "${TMPDIR:-/tmp}/implementor-ticket.XXXXXX")
  agent_node scripts/ticket.ts start "$SOURCE" --repo "$top" ${FORCE_PULL:+--force-pull} ${PARENT_RUN:+--parent-run "$PARENT_RUN"} > "$out"; code=$?
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
# owner/name of a GitHub remote URL, or nothing.
github_of() {
  local url=$1
  url=${url%.git}
  url=${url%/}
  if [[ $url =~ ^(https?://(www\.)?github\.com/|git@github\.com:|ssh://git@github\.com/)([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)$ ]]; then printf '%s\n' "${BASH_REMATCH[3]}"; fi
}
cmd_start() {
  parse "$@"
  if [ -n "$LOCAL" ] && [ -z "$CLOUD" ]; then local_step; return; fi
  [ -z "$GUIDELINES$PARALLEL$SERIAL$WORK$FINISH$VERIFY$PR_URL$REPLACE_PENDING$ATTACH" ] || die "--guidelines, --max-parallel, --serial, --work, --finish, --verify, --pr-url, --replace-pending and --attach are for local, the default mode; the agent loads its rules from Notion"
  local repo ref=$REF source=$SOURCE folder="" top="" export_dir=""
  resolve_agent
  node_args
  command -v node >/dev/null || die "node is not installed"
  if [ -n "$NO_TICKET" ] && [ -n "$REPO" ] && is_github "$REPO"; then
    repo=$REPO
    [[ $source != /* ]] || die "the source must be a path inside the repository, not an absolute local path: $source"
  else
    # A local checkout: the agent clones its GitHub origin, so the source must be committed and pushed there.
    local dir file branch
    if [ -n "$REPO" ] && is_github "$REPO"; then die "--repo $REPO is a GitHub repository, which takes a path in it; pass --repo owner/name with --no-ticket and the path"; fi
    dir=${REPO:-$PWD}
    [ -d "$dir" ] || die "not a directory: $dir"
    top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || die "$dir is not in a git repository; pass --repo owner/name with --no-ticket"
    top=$(cd "$top" && pwd -P)
    if [ -z "$NO_TICKET" ]; then
      # The agent clones the GitHub repository, so it cannot read the ticket's working folder when .work/ is
      # gitignored (as kit init makes it). Refuse before any board action, so the card is not claimed for nothing.
      if git -C "$top" check-ignore -q --no-index .work 2>/dev/null; then
        die "the separate-process implementor clones $(github_of "$(git -C "$top" remote get-url origin 2>/dev/null || true)") from GitHub and cannot read .work/ (gitignored), where the ticket's plan is pulled to. Run the ticket in this session (/aspira-implementor <ticket>, without --cloud), or pass a committed plan path with --no-ticket. No board move was made."
      fi
      ticket_start "$top"
      folder=$T_FOLDER
      file=$T_INPUT
      [ -n "$file" ] && [ -f "$file" ] || die "$T_ID has no Plan page yet (expected $folder/plan.review/plan.reviewed.md); the planner puts it there"
      printf 'ticket: %s %s (%s)\nstatus: %s -> %s\nfolder: %s\n' "$T_ID" "$T_TITLE" "$T_URL" "$T_BEFORE" "$T_STATUS" "$folder"
    else
      file=$(absolute_path "$source")
      [ -e "$file" ] || die "no such file or directory: $source"
    fi
    file=$(cd "$(dirname "$file")" && pwd -P)/$(basename "$file")
    [[ $file == "$top"/* ]] || die "$source is not inside $top"
    source=${file#"$top"/}
    [ -z "$folder" ] || export_dir=$top/$(dirname "$source")
    repo=$(github_of "$(git -C "$top" remote get-url origin 2>/dev/null || true)")
    [ -n "$repo" ] || die "the origin of $top is not a GitHub repository; pass --repo owner/name with --no-ticket, or drop --cloud"
    [ -n "$(git -C "$top" ls-files -- "$source")" ] || die "$source is not committed; the agent clones $repo and cannot see it. Commit and push it, or drop --cloud"
    [ -z "$(git -C "$top" status --porcelain -- "$source")" ] || die "$source has uncommitted changes; commit and push them, or drop --cloud"
    branch=$(git -C "$top" rev-parse --abbrev-ref HEAD)
    [ -n "$ref" ] || ref=$branch
    if [ "$ref" = "$branch" ]; then
      git -C "$top" rev-parse --verify -q '@{u}' >/dev/null || die "$branch is not pushed to $repo; push it, or drop --cloud"
      [ "$(git -C "$top" rev-list --count '@{u}..HEAD')" = 0 ] || die "$branch has commits not pushed to $repo; push them, or drop --cloud"
    fi
  fi
  local run prompt eve=""
  command -v screen >/dev/null || die "screen is not installed"
  [ -e "$PROJECT/.env.local" ] || [ -e "$AGENT/.env.local" ] || [ -n "${AI_GATEWAY_API_KEY:-}" ] || die "missing $PROJECT/.env.local (or the agent's .env.local) or AI_GATEWAY_API_KEY"
  eve=$(eve_bin)
  run=$(mktemp -d "${TMPDIR:-/tmp}/implementor.XXXXXX")
  local board_note=""
  [ -z "$folder" ] || board_note=" The ticket's board moves and pushes are made by the launcher around this run; do not call board yourself."
  prompt="Implement $source in the GitHub repository $repo${ref:+, starting from branch $ref}. Follow the aspira-implementor skill. $([ "$PR" = 1 ] && echo 'Push the branch and open a draft pull request.' || echo 'Push the branch; do not open a pull request.')$board_note Report status, branch, commits, the feature table, deviations, blockers and the pull request link if any."
  printf '%s\n' "$repo" > "$run/repo"
  printf '%s\n' "$export_dir" > "$run/output"
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
# The board step after the run: push the implementation report; set the PR and move the card only
# when the agent opened the PR, else the card stays In Progress: Implementation. export-record.ts
# reads the agent's own reported status out of the log (the same idea the old grep had, done
# properly) and writes trace/implementation-local.json, so finish always has a run record to read.
if [ -n "$FOLDER" ]; then
  node "${NODE_ARGS[@]}" "$AGENT/scripts/export-record.ts" --log "$RUN/log" --export "$EXPORT" >> "$RUN/log" 2>&1 || true
  status=$(node -p "try { JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).status ?? 'incomplete' } catch { 'incomplete' }" "$EXPORT/trace/implementation-local.json" 2>/dev/null || echo incomplete)
  pr_url=""
  [ "$PR" != 1 ] || pr_url=$(grep -oE 'https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[0-9]+' "$RUN/log" | head -n 1 || true)
  # The run's telemetry (KIT-19): the run id and start time ticket.ts start printed, or the build-feature
  # step this run is (--parent-run), which writes none of its own.
  telemetry=()
  [ -z "$RUN_ID" ] || telemetry+=(--run-id "$RUN_ID" --run-started "$RUN_STARTED")
  [ -z "$PARENT_RUN" ] || telemetry+=(--parent-run "$PARENT_RUN")
  node "${NODE_ARGS[@]}" "$AGENT/scripts/ticket.ts" finish --repo "$REPO_TOP" --folder "$FOLDER" --run-status "$status" ${pr_url:+--pr-url "$pr_url"} --export "$EXPORT" ${telemetry[@]+"${telemetry[@]}"} >> "$RUN/log" 2>&1
fi
RUNNER
  chmod +x "$run/run.sh"
  AGENT="$AGENT" EVE="$eve" PROMPT="$prompt" RUN="$run" FOLDER="$folder" REPO_TOP="$top" EXPORT="$export_dir" PR="$PR" RUN_ID="$T_RUN_ID" RUN_STARTED="$T_RUN_STARTED" PARENT_RUN="$PARENT_RUN" screen -dmS "implementor-$(basename "$run")" "$run/run.sh"
  printf 'started\nrun: %s\nrepo: %s\nsource: %s\nref: %s\npull request: %s\n' "$run" "$repo" "$source" "${ref:-default branch}" "$([ "$PR" = 1 ] && echo draft || echo no)"
  agent_line
}
# One synchronous step of a --local build: no model calls here, so no screen, gateway key or wait.
# The driver prints the board stage first (the ticket's resolve, pull and claim for the session to
# perform), then knowledge and the build stages, then the finished run with the end board actions;
# --verify is the last step, once the session made the moves.
local_step() {
  [ -z "$CLOUD" ] || die "--cloud runs the separate agent: use the start command, not local"
  [ -z "$REF$PR" ] || die "--ref and --pr are for the agent (--cloud); the default mode builds the checkout you are in and pushes nothing"
  [ -n "$VERIFY" ] || [ -z "$PR_URL$REPLACE_PENDING" ] || die "--pr-url and --replace-pending are only for --verify"
  if [ -n "$REPO" ] && is_github "$REPO"; then die "the default mode builds a local checkout; $REPO is a GitHub repository. Pass --cloud to launch the agent on it"; fi
  local top args
  top=$(repo_top)
  args=(--repo "$top")
  if [ -n "$NO_TICKET" ]; then args+=(--no-ticket "$(absolute_path "$SOURCE")"); elif [ -n "$SOURCE" ]; then args+=(--ticket "$SOURCE"); fi
  [ -z "$GUIDELINES" ] || args+=(--guidelines "$GUIDELINES")
  [ -z "$PARALLEL" ] || args+=(--max-parallel "$PARALLEL")
  [ -z "$SERIAL" ] || args+=(--serial)
  [ -z "$WORK" ] || args+=(--work "$WORK")
  [ -z "$FORCE_PULL" ] || args+=(--force-pull)
  [ -z "$VERIFY" ] || args+=(--verify)
  [ -z "$PR_URL" ] || args+=(--pr-url "$PR_URL")
  [ -z "$REPLACE_PENDING" ] || args+=(--replace-pending)
  [ -z "$FINISH" ] || args+=(--finish)
  [ -z "$PARENT_RUN" ] || args+=(--parent-run "$PARENT_RUN")
  [ -z "$ATTACH" ] || args+=(--attach "$ATTACH")
  command -v node >/dev/null || die "node is not installed"
  resolve_agent
  agent_node scripts/local.ts "${args[@]}"
}
cmd_status() {
  local run=${1:?usage: implementor.sh status RUN} elapsed output
  [ -f "$run/started" ] || die "not a run directory: $run"
  elapsed=$(( $(date +%s) - $(cat "$run/started") ))
  if [ ! -f "$run/exit" ]; then
    printf 'running (%ss)\nlog: %s/log\n' "$elapsed" "$run"
    [ ! -f "$run/log" ] || tail -n 3 "$run/log"
    exit 75
  fi
  output=$(cat "$run/output" 2>/dev/null)
  report_record "$output/trace/implementation-local.json"
  printf 'finished (%ss), exit %s\nrepo: %s\n' "$elapsed" "$(cat "$run/exit")" "$(cat "$run/repo")"
  [ ! -f "$run/agent" ] || cat "$run/agent"
  [ ! -f "$run/log" ] || tail -n 60 "$run/log"
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
  [ -n "$out" ] || die "usage: implementor.sh load-knowledge --out DIR"
  resolve_agent
  node_args
  command -v node >/dev/null || die "node is not installed"
  local common
  common="$AGENT/../common"; [ -d "$common" ] || die "common is missing beside $AGENT; reinstall @aspiralabs/ai"
  node "${NODE_ARGS[@]}" "$common/scripts/load-knowledge.ts" --out "$out"
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
  load-knowledge) shift; cmd_load_knowledge "$@" ;;
  *) die "usage: implementor.sh start [TICKET | <path-in-repo> --no-ticket] [--repo owner/name | --repo DIR] [--ref BRANCH] [--pr] [--force-pull] [--parent-run RUN:NONCE] | status RUN | wait RUN [--max SECONDS] | local [TICKET | <source> --no-ticket] [--repo DIR] [--guidelines FILE] [--max-parallel N] [--serial] [--work DIR] [--force-pull] [--verify [--pr-url URL] [--replace-pending]] [--finish] [--parent-run RUN:NONCE] [--attach JSON] | load-knowledge --out DIR" ;;
esac
