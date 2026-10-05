#!/bin/bash
# Launch the official pr-reviewer without keeping the caller's tool invocation open (start/status/wait),
# or step a --local review whose model work runs in the calling Claude Code session (local).
set -euo pipefail

die() { echo "pr-reviewer: $*" >&2; exit 1; }
agent_dir() {
  local here candidate
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  for candidate in "${PR_REVIEWER_AGENT_DIR:-}" "${ASPIRA_KIT:+$ASPIRA_KIT/packages/agents/pr-reviewer}" "$here/../../.."; do
    [ -n "$candidate" ] || continue
    if grep -qs '"name": "@aspiralabs/pr-reviewer"' "$candidate/package.json"; then
      (cd "$candidate" && pwd -P)
      return
    fi
  done
  die "cannot find pr-reviewer; set ASPIRA_KIT or PR_REVIEWER_AGENT_DIR"
}
# A directory is a local repository and is made absolute (the agent runs from its own package
# directory); anything else is passed on as a GitHub PR reference.
absolute_source() {
  if [ -d "$1" ]; then (cd "$1" && pwd -P); else printf '%s\n' "$1"; fi
}
absolute_path() {
  if [[ $1 = /* ]]; then printf '%s\n' "$1"; else printf '%s/%s\n' "$PWD" "$1"; fi
}
SOURCE="" BRANCH="" BASE="" ROUNDS="" OUT="" KNOWLEDGE="" NO_COMMENT="" FINISH=""
parse() {
  local mode=$1; shift
  while [ $# -gt 0 ]; do
    case $1 in
      --branch) [ $# -ge 2 ] || die "--branch needs a name"; BRANCH=$2; shift 2 ;;
      --base) [ $# -ge 2 ] || die "--base needs a ref"; BASE=$2; shift 2 ;;
      --max-rounds) [ $# -ge 2 ] || die "--max-rounds needs a number"; ROUNDS=$2; shift 2 ;;
      --output) [ $# -ge 2 ] || die "--output needs a path"; OUT=$(absolute_path "$2"); shift 2 ;;
      --knowledge) [ "$mode" = local ] || die "--knowledge is for local; the agent loads the guidelines itself"; [ $# -ge 2 ] || die "--knowledge needs a path"; KNOWLEDGE=$(absolute_path "$2"); shift 2 ;;
      --no-comment) NO_COMMENT=1; shift ;;
      --local) shift ;;
      --finish) [ "$mode" = local ] || die "--finish is for local"; FINISH=1; shift ;;
      -*) die "unknown option: $1" ;;
      *) [ -z "$SOURCE" ] || die "one PR at a time"; SOURCE=${1#@}; shift ;;
    esac
  done
  [ -n "$SOURCE" ] || die "usage: pr-reviewer.sh $mode <github-pr | repo-path> [--branch B] [--base main] [--max-rounds N] [--no-comment] [--output DIR]$([ "$mode" = local ] && echo ' [--knowledge DIR] [--finish]')"
  if [ -n "$ROUNDS" ]; then
    [[ $ROUNDS =~ ^[0-9]+$ ]] && [ "$ROUNDS" -ge 1 ] && [ "$ROUNDS" -le 10 ] || die "--max-rounds must be 1..10"
  fi
  SOURCE=$(absolute_source "$SOURCE")
}
cmd_start() {
  parse start "$@"
  local agent run prompt
  agent=$(agent_dir)
  command -v pnpm >/dev/null || die "pnpm is not installed"
  command -v screen >/dev/null || die "screen is not installed"
  [ -e "$agent/.env.local" ] || [ -n "${AI_GATEWAY_API_KEY:-}" ] || die "missing agent .env.local or AI_GATEWAY_API_KEY"
  if [ -d "$SOURCE" ]; then
    if [ -n "$BRANCH" ]; then prompt="Review the branch $BRANCH in $SOURCE against ${BASE:-main}"; else prompt="Review the checked-out branch in $SOURCE against ${BASE:-main}"; fi
  else
    [ -z "$BRANCH$BASE" ] || die "--branch and --base are for a local repository; a GitHub PR already says what it is against"
    prompt="Review $SOURCE"
  fi
  [ -z "$ROUNDS" ] || prompt="$prompt, cap it at $ROUNDS rounds"
  prompt="$prompt."
  [ -z "$OUT" ] || prompt="$prompt Write the review to $OUT."
  [ -z "$NO_COMMENT" ] || prompt="$prompt Do not comment on the PR."
  run=$(mktemp -d "${TMPDIR:-/tmp}/pr-reviewer.XXXXXX")
  printf '%s\n' "$SOURCE" > "$run/source"
  date +%s > "$run/started"
  cat > "$run/run.sh" <<'RUNNER'
#!/bin/bash
pnpm -C "$AGENT" exec eve invoke "$PROMPT" > "$RUN/log" 2>&1
code=$?
printf '%s\n' "$code" > "$RUN/exit"
RUNNER
  chmod +x "$run/run.sh"
  AGENT="$agent" PROMPT="$prompt" RUN="$run" screen -dmS "pr-review-$(basename "$run")" "$run/run.sh"
  printf 'started\nrun: %s\nsource: %s\n' "$run" "$SOURCE"
}
# One synchronous step of a --local review: no model calls here, so no screen, gateway key or wait.
# Prints the next stage's tasks (prompt + output file each) or the exported review as JSON.
cmd_local() {
  parse local "$@"
  local args=("$SOURCE")
  [ -z "$BRANCH" ] || args+=(--branch "$BRANCH")
  [ -z "$BASE" ] || args+=(--base "$BASE")
  [ -z "$ROUNDS" ] || args+=(--max-rounds "$ROUNDS")
  [ -z "$NO_COMMENT" ] || args+=(--no-comment)
  [ -z "$OUT" ] || args+=(--output "$OUT")
  [ -z "$KNOWLEDGE" ] || args+=(--knowledge "$KNOWLEDGE")
  [ -z "$FINISH" ] || args+=(--finish)
  command -v pnpm >/dev/null || die "pnpm is not installed"
  pnpm -C "$(agent_dir)" --silent run review:local "${args[@]}"
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
  *) die "usage: pr-reviewer.sh start SOURCE [--branch B] [--base main] [--max-rounds N] [--no-comment] [--output DIR] | status RUN | wait RUN [--max SECONDS] | local SOURCE [--branch B] [--base main] [--max-rounds N] [--no-comment] [--output DIR] [--knowledge DIR] [--finish]" ;;
esac
