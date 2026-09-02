#!/usr/bin/env bash
set -Eeuo pipefail

IMAGE_TAG="${1:?image tag is required}"
IMAGE_PREFIX="${2:?image prefix is required}"
DEPLOY_ROOT="${3:-/opt/signal-archive}"
COMPOSE_FILE="$DEPLOY_ROOT/compose.production.yaml"
ENV_FILE="$DEPLOY_ROOT/.env"
STATE_FILE="$DEPLOY_ROOT/current-tag"

test -f "$ENV_FILE"
test -f "$COMPOSE_FILE"
test -f "$DEPLOY_ROOT/Caddyfile"

previous_tag=''
if [[ -s "$STATE_FILE" ]]; then
  previous_tag="$(head -n 1 "$STATE_FILE")"
fi

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

healthcheck() {
  for attempt in $(seq 1 30); do
    if curl --fail --silent --show-error --max-time 10 \
      --proto '=https' --tlsv1.2 https://signal.jisung.lol/health/live >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

export IMAGE_TAG IMAGE_PREFIX
compose pull

# Drizzle migrations are forward-only and must complete before application rollout.
# The image's drizzle.config.ts prefers the server-owned DATABASE_URL_DIRECT.
docker run --rm --env-file "$ENV_FILE" \
  "$IMAGE_PREFIX/api:$IMAGE_TAG" \
  pnpm --filter @techpulse/database run db:migrate

if ! compose up -d --wait; then
  rollout_failed=1
else
  rollout_failed=0
fi

if [[ "$rollout_failed" -eq 0 ]] && healthcheck; then
  printf '%s\n' "$IMAGE_TAG" > "$STATE_FILE"
  echo "production rollout healthy: $IMAGE_TAG (https://signal.jisung.lol/)"
  exit 0
fi

echo "production rollout failed health check: $IMAGE_TAG" >&2
if [[ -n "$previous_tag" && "$previous_tag" != "$IMAGE_TAG" ]]; then
  echo "attempting application rollback to previous image tag: $previous_tag" >&2
  export IMAGE_TAG="$previous_tag"
  compose pull
  compose up -d --wait
  if healthcheck; then
    printf '%s\n' "$previous_tag" > "$STATE_FILE"
    echo "rollback healthy: $previous_tag (https://signal.jisung.lol/)" >&2
  else
    echo "rollback health check failed; manual intervention required" >&2
  fi
fi
exit 1
