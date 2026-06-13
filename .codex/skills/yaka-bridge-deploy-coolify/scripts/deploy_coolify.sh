#!/usr/bin/env bash
set -euo pipefail

set +x

usage() {
  cat <<'USAGE'
Trigger a Yaka-Bridge deployment on Coolify without printing secrets.

Preferred:
  COOLIFY_DEPLOY_WEBHOOK="https://coolify.example.com/api/v1/deploy?uuid=...&force=false"
  COOLIFY_TOKEN="..." # optional if your webhook requires Authorization

Alternative:
  COOLIFY_URL="https://coolify.example.com"
  COOLIFY_RESOURCE_UUID="..."
  COOLIFY_TOKEN="..."
  COOLIFY_FORCE="false" # optional, defaults to false

Aliases:
  COOLIFY_WEBHOOK, COOLIFY_RESOURCE_ID, COOLIFY_API_TOKEN

Options:
  --dry-run   Validate configuration without calling Coolify
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

webhook="${COOLIFY_DEPLOY_WEBHOOK:-${COOLIFY_WEBHOOK:-}}"
token="${COOLIFY_TOKEN:-${COOLIFY_API_TOKEN:-}}"
force="${COOLIFY_FORCE:-false}"
method="${COOLIFY_METHOD:-GET}"

if [[ -n "$webhook" ]]; then
  url="$webhook"
  mode="webhook"
else
  coolify_url="${COOLIFY_URL:-}"
  resource_uuid="${COOLIFY_RESOURCE_UUID:-${COOLIFY_RESOURCE_ID:-}}"

  if [[ -z "$coolify_url" || -z "$resource_uuid" || -z "$token" ]]; then
    cat >&2 <<'ERROR'
Missing Coolify deployment configuration.

Set either:
  COOLIFY_DEPLOY_WEBHOOK

Or:
  COOLIFY_URL
  COOLIFY_RESOURCE_UUID
  COOLIFY_TOKEN
ERROR
    exit 2
  fi

  coolify_url="${coolify_url%/}"
  url="${coolify_url}/api/v1/deploy?uuid=${resource_uuid}&force=${force}"
  mode="api"
fi

if [[ "$method" != "GET" && "$method" != "POST" ]]; then
  echo "COOLIFY_METHOD must be GET or POST." >&2
  exit 2
fi

if [[ "$dry_run" -eq 1 ]]; then
  echo "Coolify deploy configuration OK."
  echo "Mode: ${mode}"
  echo "Method: ${method}"
  echo "Authorization header: $([[ -n "$token" ]] && echo present || echo absent)"
  exit 0
fi

headers=(-H "Accept: application/json")
if [[ -n "$token" ]]; then
  headers+=(-H "Authorization: Bearer ${token}")
fi

echo "Triggering Coolify deployment (${mode}, ${method})..."
curl -fsS --request "$method" "${headers[@]}" "$url"
echo
echo "Coolify deployment trigger sent."
