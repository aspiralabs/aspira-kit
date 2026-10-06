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
absolute_path() {
  if [[ $1 = /* ]]; then printf '%s\n' "$1"; else printf '%s/%s\n' "$PWD" "$1"; fi
}
is_github() {
  [[ $1 =~ ^(https?://(www\.)?github\.com/|git@github\.com:)?[A-Za-z0-9_-][A-Za-z0-9_.-]*/[A-Za-z0-9_.-]+(\.git)?/?$ ]] && [ ! -d "$1" ]
}
SOURCE="" REPO="" REF="" PR="" LOCAL="" GUIDELINES="" PARALLEL="" SERIAL="" WORK="" FINISH="" NO_TICKET="" FORCE_PULL="" VERIFY=""
# The first positional is the Feature Board ticket (an ID such as NOM-4, or a Notion page URL), or
# nothing (the one folder under .work/ with a ticket.md), or, with --no-ticket, the source path as before.
parse() {
  while [ $# -gt 0 ]; do
    case $1 in
      --repo) [ $# -ge 2 ] || die "--repo needs a directory or owner/name"; REPO=$2; shift 2 ;;
      --ref) [ $# -ge 2 ] || die "--ref needs a branch"; REF=$2; shift 2 ;;
      --pr) PR=1; shift ;;
      --local) LOCAL=1; shift ;;
      --no-ticket) NO_TICKET=1; shift ;;
      --force-pull) FORCE_PULL=1; shift ;;
      --verify) VERIFY=1; shift ;;
      --guidelines) [ $# -ge 2 ] || die "--guidelines needs a file"; GUIDELINES=$(absolute_path "$2"); shift 2 ;;
      --max-parallel) [ $# -ge 2 ] || die "--max-parallel needs a number"; PARALLEL=$2; shift 2 ;;
      --serial) SERIAL=1; shift ;;
      --work) [ $# -ge 2 ] || die "--work needs a directory"; WORK=$(absolute_path "$2"); shift 2 ;;
      --finish) FINISH=1; shift ;;
      -*) die "unknown option: $1" ;;
      *) [ -z "$SOURCE" ] || die "one ticket at a time (or one source with --no-ticket)"; SOURCE=${1#@}; shift ;;
    esac
  done
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
# lines of scripts/ticket.ts into T_FOLDER, T_ID, T_TITLE, T_URL, T_BEFORE, T_STATUS, T_INPUT.
ticket_start() {
  local top=$1 out code line key value
  out=$(mktemp "${TMPDIR:-/tmp}/implementor-ticket.XXXXXX")
  agent_node scripts/ticket.ts start "$SOURCE" --repo "$top" ${FORCE_PULL:+--force-pull} > "$out"; code=$?
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
  [ -z "$GUIDELINES$PARALLEL$SERIAL$WORK$FINISH$VERIFY" ] || die "--guidelines, --max-parallel, --serial, --work, --finish and --verify are for --local; the agent loads its rules from Notion"
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
        die "the separate-process implementor clones $(github_of "$(git -C "$top" remote get-url origin 2>/dev/null || true)") from GitHub and cannot read .work/ (gitignored), where the ticket's plan is pulled to. Run the ticket with --local (/aspira-implementor <ticket> --local), or pass a committed plan path with --no-ticket. No board move was made."
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
    [ -n "$repo" ] || die "the origin of $top is not a GitHub repository; pass --repo owner/name with --no-ticket, or use --local"
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
  command -v screen >/dev/null || die "screen is not installed"
  [ -e "$PROJECT/.env.local" ] || [ -e "$AGENT/.env.local" ] || [ -n "${AI_GATEWAY_API_KEY:-}" ] || die "missing $PROJECT/.env.local (or the agent's .env.local) or AI_GATEWAY_API_KEY"
  eve=$(eve_bin)
  run=$(mktemp -d "${TMPDIR:-/tmp}/implementor.XXXXXX")
  local board_note=""
  [ -z "$folder" ] || board_note=" The ticket's board moves and pushes are made by the launcher around this run; do not call board yourself."
  prompt="Implement $source in the GitHub repository $repo${ref:+, starting from branch $ref}. Follow the aspira-implementor skill. $([ "$PR" = 1 ] && echo 'Push the branch and open a draft pull request.' || echo 'Push the branch; do not open a pull request.')$board_note Report status, branch, commits, the feature table, deviations, blockers and the pull request link if any."
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
# The board step after the run: push the implementation report; set the PR and move the card only
# when the agent opened the PR, else the card stays In Progress: Implementation.
if [ -n "$FOLDER" ]; then
  if grep -qiE '^status:? *complete|"status": *"complete"' "$RUN/log"; then outcome=--ok; status=complete; else outcome=--failed; status=incomplete; fi
  pr_url=""
  [ "$PR" != 1 ] || pr_url=$(grep -oE 'https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[0-9]+' "$RUN/log" | head -n 1 || true)
  node "${NODE_ARGS[@]}" "$AGENT/scripts/ticket.ts" finish --repo "$REPO_TOP" --folder "$FOLDER" "$outcome" --run-status "$status" ${pr_url:+--pr-url "$pr_url"} --export "$EXPORT" >> "$RUN/log" 2>&1
fi
RUNNER
  chmod +x "$run/run.sh"
  AGENT="$AGENT" EVE="$eve" PROMPT="$prompt" RUN="$run" FOLDER="$folder" REPO_TOP="$top" EXPORT="$export_dir" PR="$PR" screen -dmS "implementor-$(basename "$run")" "$run/run.sh"
  printf 'started\nrun: %s\nrepo: %s\nsource: %s\nref: %s\npull request: %s\n' "$run" "$repo" "$source" "${ref:-default branch}" "$([ "$PR" = 1 ] && echo draft || echo no)"
  agent_line
}
# One synchronous step of a --local build: no model calls here, so no screen, gateway key or wait.
# The driver prints the board stage first (the ticket's resolve, pull and claim for the session to
# perform), then knowledge and the build stages, then the finished run with the end board actions;
# --verify is the last step, once the session made the moves.
local_step() {
  [ -z "$REF$PR" ] || die "--ref and --pr are for the agent; --local builds the checkout you are in and pushes nothing"
  if [ -n "$REPO" ] && is_github "$REPO"; then die "--local builds a local checkout; $REPO is a GitHub repository. Drop --local to launch the agent on it"; fi
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
  *) die "usage: implementor.sh start [TICKET | <path-in-repo> --no-ticket] [--repo owner/name | --repo DIR] [--ref BRANCH] [--pr] [--force-pull] | status RUN | wait RUN [--max SECONDS] | local [TICKET | <source> --no-ticket] [--repo DIR] [--guidelines FILE] [--max-parallel N] [--serial] [--work DIR] [--force-pull] [--verify] [--finish]" ;;
esac
