#!/bin/bash
# Launch the implementor agent on a GitHub repository without keeping the caller's tool invocation
# open (start/status/wait), or step a --local build whose model work runs in the calling Claude Code
# session (local).
set -euo pipefail

die() { echo "implementor: $*" >&2; exit 1; }
agent_dir() {
  local here candidate
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  for candidate in "${IMPLEMENTOR_AGENT_DIR:-}" "${ASPIRA_KIT:+$ASPIRA_KIT/packages/agents/implementor}" "$here/../../.."; do
    [ -n "$candidate" ] || continue
    if grep -qs '"name": "@aspiralabs/implementor"' "$candidate/package.json"; then
      (cd "$candidate" && pwd -P)
      return
    fi
  done
  die "cannot find the implementor agent; set ASPIRA_KIT or IMPLEMENTOR_AGENT_DIR"
}
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
  local agent run prompt
  agent=$(agent_dir)
  command -v pnpm >/dev/null || die "pnpm is not installed"
  command -v screen >/dev/null || die "screen is not installed"
  [ -e "$agent/.env.local" ] || [ -n "${AI_GATEWAY_API_KEY:-}" ] || die "missing agent .env.local or AI_GATEWAY_API_KEY"
  run=$(mktemp -d "${TMPDIR:-/tmp}/implementor.XXXXXX")
  prompt="Implement $source in the GitHub repository $repo${ref:+, starting from branch $ref}. Follow the aspira-implementor skill. $([ "$PR" = 1 ] && echo 'Push the branch and open a draft pull request.' || echo 'Push the branch; do not open a pull request.') Report status, branch, commits, the feature table, deviations, blockers and the pull request link if any."
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
  printf 'started\nrun: %s\nrepo: %s\nsource: %s\nref: %s\npull request: %s\n' "$run" "$repo" "$source" "${ref:-default branch}" "$([ "$PR" = 1 ] && echo draft || echo no)"
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
  command -v pnpm >/dev/null || die "pnpm is not installed"
  pnpm -C "$(agent_dir)" --silent run implement:local "${args[@]}"
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
