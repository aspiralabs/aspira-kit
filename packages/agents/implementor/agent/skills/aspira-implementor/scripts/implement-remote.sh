#!/bin/bash
# Launch the implementor agent on a GitHub repository without keeping the caller's tool invocation open.
set -euo pipefail

die() { echo "implement-remote: $*" >&2; exit 1; }
agent_dir() {
  local here candidate
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  for candidate in "${IMPLEMENTOR_AGENT_DIR:-}" "${ASPIRA_KIT:+$ASPIRA_KIT/packages/agents/implementor}" "$here/../../../.."; do
    [ -n "$candidate" ] || continue
    if grep -qs '"name": "@aspiralabs/implementor"' "$candidate/package.json"; then
      (cd "$candidate" && pwd -P)
      return
    fi
  done
  die "cannot find the implementor agent; set ASPIRA_KIT or IMPLEMENTOR_AGENT_DIR"
}
cmd_start() {
  local repo="" source="" ref="" pr=0
  while [ $# -gt 0 ]; do
    case $1 in
      --ref) [ $# -ge 2 ] || die "--ref needs a branch"; ref=$2; shift 2 ;;
      --pr) pr=1; shift ;;
      -*) die "unknown option: $1" ;;
      *) if [ -z "$repo" ]; then repo=$1; elif [ -z "$source" ]; then source=${1#@}; else die "unexpected argument: $1"; fi; shift ;;
    esac
  done
  [ -n "$repo" ] && [ -n "$source" ] || die "usage: implement-remote.sh start <owner/name | url> <path-in-repo> [--ref BRANCH] [--pr]"
  [[ $repo =~ ^(https?://(www\.)?github\.com/|git@github\.com:)?[A-Za-z0-9_-][A-Za-z0-9_.-]*/[A-Za-z0-9_.-]+(\.git)?/?$ ]] || die "not a GitHub repository: $repo"
  [[ $source != /* ]] || die "the source must be a path inside the repository, not an absolute local path: $source"
  local agent run prompt
  agent=$(agent_dir)
  command -v pnpm >/dev/null || die "pnpm is not installed"
  command -v screen >/dev/null || die "screen is not installed"
  [ -e "$agent/.env.local" ] || [ -n "${AI_GATEWAY_API_KEY:-}" ] || die "missing agent .env.local or AI_GATEWAY_API_KEY"
  run=$(mktemp -d "${TMPDIR:-/tmp}/implementor.XXXXXX")
  prompt="Implement $source in the GitHub repository $repo${ref:+, starting from branch $ref}. Follow the aspira-implementor skill. $([ $pr = 1 ] && echo 'Push the branch and open a draft pull request.' || echo 'Push the branch; do not open a pull request.') Report status, branch, commits, the feature table, deviations, blockers and the pull request link if any."
  printf '%s\n' "$repo" > "$run/repo"
  date +%s > "$run/started"
  cat > "$run/run.sh" <<'RUNNER'
#!/bin/bash
pnpm -C "$AGENT" exec eve invoke "$PROMPT" > "$RUN/log" 2>&1
code=$?
printf '%s\n' "$code" > "$RUN/exit"
RUNNER
  chmod +x "$run/run.sh"
  AGENT="$agent" PROMPT="$prompt" RUN="$run" screen -dmS "implementor-$(basename "$run")" "$run/run.sh"
  printf 'started\nrun: %s\nrepo: %s\nsource: %s\nref: %s\npull request: %s\n' "$run" "$repo" "$source" "${ref:-default branch}" "$([ $pr = 1 ] && echo draft || echo no)"
}
cmd_status() {
  local run=${1:?usage: implement-remote.sh status RUN} elapsed
  [ -f "$run/started" ] || die "not a run directory: $run"
  elapsed=$(( $(date +%s) - $(cat "$run/started") ))
  if [ ! -f "$run/exit" ]; then
    printf 'running (%ss)\nlog: %s/log\n' "$elapsed" "$run"
    [ ! -f "$run/log" ] || tail -n 3 "$run/log"
    return
  fi
  printf 'finished (%ss), exit %s\nrepo: %s\n' "$elapsed" "$(cat "$run/exit")" "$(cat "$run/repo")"
  tail -n 60 "$run/log"
}
cmd_wait() {
  local run=${1:?usage: implement-remote.sh wait RUN [--max SECONDS]} max=30 deadline
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
  *) die "usage: implement-remote.sh start <owner/name | url> <path-in-repo> [--ref BRANCH] [--pr] | status RUN | wait RUN [--max SECONDS]" ;;
esac
