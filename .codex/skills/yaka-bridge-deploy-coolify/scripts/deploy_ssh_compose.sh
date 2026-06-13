#!/usr/bin/env bash
set -euo pipefail

set +x

usage() {
  cat <<'USAGE'
Deploy a Git-backed Docker Compose app on the Yaka-Bridge Coolify/VPS host.

Defaults target the public Yaka-Bridge landing:
  COOLIFY_SSH_TARGET=root@92.222.247.135
  COOLIFY_APP_DIR=/opt/yaka-bridge-landing
  COOLIFY_COMPOSE_SERVICE=landing
  COOLIFY_GIT_REMOTE=origin
  COOLIFY_GIT_BRANCH=main
  COOLIFY_PUBLIC_URL=https://yaka-bridge.com/
  COOLIFY_EXPECTED_MARKER=id="bridge-svg"

Options:
  --dry-run   Print the remote state without pulling/restarting
  -h, --help  Show this help
USAGE
}

dry_run=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

target="${COOLIFY_SSH_TARGET:-root@92.222.247.135}"
app_dir="${COOLIFY_APP_DIR:-/opt/yaka-bridge-landing}"
service="${COOLIFY_COMPOSE_SERVICE:-landing}"
remote="${COOLIFY_GIT_REMOTE:-origin}"
branch="${COOLIFY_GIT_BRANCH:-main}"
public_url="${COOLIFY_PUBLIC_URL:-https://yaka-bridge.com/}"
expected_marker="${COOLIFY_EXPECTED_MARKER:-id=\"bridge-svg\"}"

remote_script='
set -euo pipefail
cd "$APP_DIR"

echo "Remote: $(hostname) $(pwd)"
test -d .git || { echo "Remote app dir is not a Git clone: $APP_DIR" >&2; exit 2; }

status="$(git status --short)"
if [ -n "$status" ]; then
  echo "Remote Git worktree is dirty:" >&2
  echo "$status" >&2
  exit 2
fi

echo "Before: $(git log -1 --oneline)"

if [ "$DRY_RUN" = "1" ]; then
  docker compose ps "$SERVICE" || true
  exit 0
fi

git pull --ff-only "$REMOTE" "$BRANCH"
echo "After:  $(git log -1 --oneline)"
docker compose up -d --build "$SERVICE"

for i in $(seq 1 30); do
  container="$(docker compose ps -q "$SERVICE")"
  status="$(docker inspect "$container" --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}" 2>/dev/null || echo unknown)"
  echo "health=$status attempt=$i"
  [ "$status" = "healthy" ] || [ "$status" = "no-healthcheck" ] && exit 0
  sleep 2
done

exit 1
'

echo "Deploying ${service} on ${target}:${app_dir}..."
ssh -o BatchMode=yes "$target" \
  "APP_DIR=$(printf '%q' "$app_dir") SERVICE=$(printf '%q' "$service") REMOTE=$(printf '%q' "$remote") BRANCH=$(printf '%q' "$branch") DRY_RUN=$(printf '%q' "$dry_run") bash -s" \
  <<< "$remote_script"

if [ "$dry_run" = "1" ]; then
  echo "Dry-run complete."
  exit 0
fi

if command -v curl >/dev/null 2>&1 && command -v grep >/dev/null 2>&1; then
  body="$(curl -fsSL --max-time 15 "$public_url")"
  if printf "%s" "$body" | grep -Fq "$expected_marker"; then
    echo "Public URL is serving expected marker: ${public_url}"
  else
    echo "Public URL did not contain expected marker yet: ${public_url}" >&2
    exit 1
  fi
fi

echo "SSH Compose deploy complete."
