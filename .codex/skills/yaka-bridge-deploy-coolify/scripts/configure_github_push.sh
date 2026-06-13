#!/usr/bin/env bash
set -euo pipefail

set +x

usage() {
  cat <<'USAGE'
Create or update the GitHub push webhook that triggers Coolify.

Required:
  GITHUB_REPO="owner/repo"
  COOLIFY_GITHUB_WEBHOOK_URL="https://coolify.example.com/webhooks/..."
  COOLIFY_GITHUB_WEBHOOK_SECRET="random-secret-from-coolify"

Optional:
  GITHUB_WEBHOOK_EVENTS="push"       # comma-separated
  GITHUB_WEBHOOK_INSECURE_SSL="0"

The script does not print webhook secrets.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

repo="${GITHUB_REPO:-}"
webhook_url="${COOLIFY_GITHUB_WEBHOOK_URL:-}"
webhook_secret="${COOLIFY_GITHUB_WEBHOOK_SECRET:-}"
events_csv="${GITHUB_WEBHOOK_EVENTS:-push}"
insecure_ssl="${GITHUB_WEBHOOK_INSECURE_SSL:-0}"

if [[ -z "$repo" || -z "$webhook_url" || -z "$webhook_secret" ]]; then
  usage >&2
  exit 2
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "Missing GitHub CLI: gh" >&2
  exit 2
fi

events_json="$(printf '%s' "$events_csv" | awk -F, '{
  printf "["
  for (i = 1; i <= NF; i++) {
    gsub(/^ +| +$/, "", $i)
    if ($i == "") continue
    printf "%s\"%s\"", seen ? "," : "", $i
    seen = 1
  }
  printf "]"
}')"

existing_id="$(
  gh api "repos/${repo}/hooks" \
    --jq '.[] | select(.name == "web" and .config.url == "'"$webhook_url"'") | .id' \
    | sed -n '1p'
)"

payload="$(
  jq -nc \
    --arg url "$webhook_url" \
    --arg secret "$webhook_secret" \
    --arg insecure_ssl "$insecure_ssl" \
    --argjson events "$events_json" \
    '{
      name: "web",
      active: true,
      events: $events,
      config: {
        url: $url,
        content_type: "json",
        secret: $secret,
        insecure_ssl: $insecure_ssl
      }
    }'
)"

if [[ -n "$existing_id" ]]; then
  gh api "repos/${repo}/hooks/${existing_id}" --method PATCH --input - <<< "$payload" >/dev/null
  echo "Updated GitHub webhook ${existing_id} for ${repo}."
else
  gh api "repos/${repo}/hooks" --method POST --input - <<< "$payload" >/dev/null
  echo "Created GitHub webhook for ${repo}."
fi

echo "Configured events: ${events_csv}"
