#!/usr/bin/env bash
set -Eeuo pipefail
TARGET_SHA="$1"
SOURCE_BUNDLE="${2:-}"
if [ "$SOURCE_BUNDLE" = - ]; then SOURCE_BUNDLE=""; fi
EXPECTED_ACTIVE_SHA="${3:-}"
EXPECTED_ACTIVE_IMAGE="${4:-}"
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 20
if [ -n "$EXPECTED_ACTIVE_SHA" ]; then
  [[ "$EXPECTED_ACTIVE_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 20
  [[ "$EXPECTED_ACTIVE_IMAGE" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 20
fi
exec 9>/var/lock/taha-ai-release.lock
flock -n 9 || { echo 'RELEASE_ALREADY_RUNNING'; exit 21; }

REPO=/var/www/taha-ai
DATA=/var/lib/taha-ai
ENV_FILE=/etc/taha-ai/.dev.vars
IMAGE_REPO=tahashoes-taha-ai
NETWORK=tahashoes_default
STAMP="$(date +%Y%m%d-%H%M%S)-$$"
CANDIDATE="taha-ai-candidate-${STAMP}"
STAGE_DATA="/var/lib/taha-ai-candidate-${STAMP}"
ROLLBACK="taha-ai-rollback-${STAMP}"
BACKUP_DIR="/var/backups/taha-ai/${STAMP}-${TARGET_SHA:0:12}"
NEW_IMAGE="${IMAGE_REPO}:${TARGET_SHA}"
OLD_SHA=$(git -C "$REPO" rev-parse HEAD)
OLD_STOPPED=no
RELEASE_OK=no
TIMER_WAS_ACTIVE=no
CHECKOUT_CHANGED=no

cleanup() {
  result=$?
  trap - EXIT
  set +e
  docker rm -f "$CANDIDATE" >/dev/null 2>&1
  rm -rf -- "$STAGE_DATA"
  if [ "$RELEASE_OK" != yes ]; then
    if [ "$OLD_STOPPED" = yes ]; then
      if docker inspect "$ROLLBACK" >/dev/null 2>&1; then
        docker rm -f taha-ai >/dev/null 2>&1
        docker rename "$ROLLBACK" taha-ai
      fi
      docker update --restart=always taha-ai >/dev/null 2>&1
      docker start taha-ai >/dev/null 2>&1
      # Preserve migrated cancellations. A failed rollout must not restart old image jobs.
      echo 'RELEASE_ROLLED_BACK_CRON_LEFT_STOPPED=yes'
      if probe 8787; then echo 'ROLLBACK_AUTHENTICATED_UI_OK=yes'; else echo 'ROLLBACK_HEALTH_FAILED_REPAIR_REQUIRED=yes'; fi
      echo 'REMEDIATION_REQUIRED=Repair release and restart taha-ai-cron.timer after validation'
    elif [ "$TIMER_WAS_ACTIVE" = yes ]; then
      systemctl start taha-ai-cron.timer
    fi
    if [ "$CHECKOUT_CHANGED" = yes ]; then git -C "$REPO" reset --hard "$OLD_SHA" >/dev/null; fi
  fi
  exit "$result"
}
trap cleanup EXIT

test -d "$DATA" && test -f "$ENV_FILE"
test -z "$(git -C "$REPO" status --porcelain)" || { echo 'VPS_CHECKOUT_HAS_LOCAL_CHANGES'; exit 22; }
docker inspect taha-ai >/dev/null
docker network inspect "$NETWORK" >/dev/null
if [ -n "$EXPECTED_ACTIVE_SHA" ]; then
  test "$(git -C "$REPO" rev-parse HEAD)" = "$EXPECTED_ACTIVE_SHA" || { echo 'EXPECTED_ACTIVE_SOURCE_CHANGED'; exit 30; }
  test "$(docker inspect taha-ai -f '{{.Config.Image}}')" = "${IMAGE_REPO}:${EXPECTED_ACTIVE_SHA}" || { echo 'EXPECTED_ACTIVE_IMAGE_CHANGED'; exit 30; }
  test "$(docker inspect taha-ai -f '{{.Image}}')" = "$EXPECTED_ACTIVE_IMAGE" || { echo 'EXPECTED_ACTIVE_DIGEST_CHANGED'; exit 30; }
  test "$(docker inspect taha-ai -f '{{.State.Status}}')" = running || { echo 'EXPECTED_ACTIVE_STATUS_CHANGED'; exit 30; }
  test "$(docker image inspect "${IMAGE_REPO}:${EXPECTED_ACTIVE_SHA}" -f '{{.Id}}')" = "$EXPECTED_ACTIVE_IMAGE" || { echo 'EXPECTED_ACTIVE_TAG_CHANGED'; exit 30; }
  test "$(docker image inspect "$EXPECTED_ACTIVE_IMAGE" -f '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$EXPECTED_ACTIVE_SHA" || { echo 'EXPECTED_ACTIVE_REVISION_CHANGED'; exit 30; }
fi
MIN_RELEASE_FREE_KB=5242880
FREE_KB=$(df --output=avail -k / | tail -1 | tr -d ' ')
if [ "$FREE_KB" -lt "$MIN_RELEASE_FREE_KB" ]; then
  echo "RELEASE_DISK_LOW_KB=$FREE_KB"
  # Build cache is disposable and is not referenced by running containers,
  # images, volumes, source bundles, backups, or the application database.
  # Keep the most recent 24 hours so unrelated active development is not
  # disturbed while old cache can no longer block a validated release.
  docker builder prune -af --filter 'until=24h'
  FREE_KB=$(df --output=avail -k / | tail -1 | tr -d ' ')
  echo "RELEASE_DISK_AFTER_CACHE_PRUNE_KB=$FREE_KB"
fi
[ "$FREE_KB" -ge "$MIN_RELEASE_FREE_KB" ] || { echo 'INSUFFICIENT_RELEASE_DISK'; exit 23; }
secret=$(python3 - "$ENV_FILE" <<'PY'
from pathlib import Path
import sys
for line in Path(sys.argv[1]).read_text().splitlines():
    key, sep, value = line.partition('=')
    if sep and key.strip() == 'INTERNAL_API_SECRET':
        print(value.strip().strip('"\''))
        break
PY
)
test -n "$secret" || { echo 'INTERNAL_API_SECRET_MISSING'; exit 24; }

if [ -n "$SOURCE_BUNDLE" ]; then
  [[ "$SOURCE_BUNDLE" = "/var/tmp/taha-source-${TARGET_SHA}.bundle" ]] || exit 28
  git -C "$REPO" bundle verify "$SOURCE_BUNDLE"
  git -C "$REPO" fetch "$SOURCE_BUNDLE" HEAD
  test "$(git -C "$REPO" rev-parse FETCH_HEAD)" = "$TARGET_SHA"
  rm -- "$SOURCE_BUNDLE"
else
  git -C "$REPO" fetch origin main
  git -C "$REPO" merge-base --is-ancestor "$TARGET_SHA" origin/main
fi
git -C "$REPO" checkout -q main
CHECKOUT_CHANGED=yes
git -C "$REPO" reset --hard "$TARGET_SHA" >/dev/null
cd "$REPO"
if ! docker image inspect "$NEW_IMAGE" >/dev/null 2>&1; then
  DOCKER_BUILDKIT=0 docker build -f deploy/vps/Dockerfile --label "org.opencontainers.image.revision=$TARGET_SHA" -t "$NEW_IMAGE" .
fi
test "$(docker inspect "$NEW_IMAGE" -f '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$TARGET_SHA"
echo "IMAGE_READY=$TARGET_SHA"

# SQLite backup API includes committed WAL records in a consistent staging snapshot.
cp -a "$DATA" "$STAGE_DATA"
chmod 700 "$STAGE_DATA"
python3 - "$DATA" "$STAGE_DATA" <<'PY'
from pathlib import Path
import sqlite3, sys
source, target = map(Path, sys.argv[1:])
for original in source.rglob('*.sqlite'):
    destination = target / original.relative_to(source)
    for suffix in ('-wal', '-shm'):
        Path(str(destination) + suffix).unlink(missing_ok=True)
    with sqlite3.connect(f'file:{original}?mode=ro', uri=True) as src:
        with sqlite3.connect(destination) as dst:
            src.backup(dst)
PY
docker run -d --name "$CANDIDATE" --network "$NETWORK" -p 127.0.0.1:18787:8787 \
  -v "$STAGE_DATA:/data" -v "$ENV_FILE:/app/.dev.vars:ro" "$NEW_IMAGE" >/dev/null

probe() {
  local port="$1" path code
  for attempt in $(seq 1 75); do
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 4 -H "Authorization: Bearer $secret" "http://127.0.0.1:$port/api/integrations" 2>/dev/null || true)
    if [ "$code" = 200 ]; then break; fi
    sleep 2
  done
  [ "$code" = 200 ] || return 1
  for path in / /automation /products /content /connections; do
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -H "Authorization: Bearer $secret" "http://127.0.0.1:$port$path")
    [ "$code" = 200 ] || { echo "UI_PROBE_FAILED=$path:$code"; return 1; }
  done
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$port/api/integrations")
  [ "$code" = 401 ]
}
probe 18787 || { echo 'CANDIDATE_PROBE_FAILED'; exit 25; }
echo 'CANDIDATE_AUTHENTICATED_UI_OK=yes'
image_probe() {
  curl --fail --silent --show-error --max-time 30 -X POST \
    -H "Authorization: Bearer $secret" "http://127.0.0.1:$1/api/internal/health/images" |
    python3 -c 'import json,sys; d=json.load(sys.stdin).get("data",{}); assert 0 < d.get("bytes",0) < 200000 and d.get("mimeType") == "image/jpeg" and d.get("width") == 1 and d.get("height") == 1; print("IMAGE_ENCODER_VERIFIED_BYTES="+str(d["bytes"]))'
}
image_probe 18787 || { echo 'CANDIDATE_IMAGE_ENCODER_FAILED'; exit 29; }
docker rm -f "$CANDIDATE" >/dev/null
rm -rf -- "$STAGE_DATA"

if systemctl is-active --quiet taha-ai-cron.timer; then TIMER_WAS_ACTIVE=yes; fi
systemctl stop taha-ai-cron.timer
# Let any in-flight external publish finish; never kill a running publish to deploy.
cron_busy() {
  # Type=oneshot is "activating" while its HTTP request is still running.
  case "$(systemctl show -p ActiveState --value taha-ai-cron.service)" in
    active|activating|deactivating) return 0 ;;
    *) return 1 ;;
  esac
}
for attempt in $(seq 1 90); do
  if ! cron_busy; then break; fi
  sleep 2
done
if cron_busy; then echo 'CRON_STILL_RUNNING'; exit 26; fi
docker stop --time 120 taha-ai >/dev/null
OLD_STOPPED=yes
install -d -m 700 "$BACKUP_DIR"
tar -C /var/lib -czf "$BACKUP_DIR/data.tgz" taha-ai
chmod 600 "$BACKUP_DIR/data.tgz"
docker inspect taha-ai > "$BACKUP_DIR/container.json"
printf '%s\n' "$OLD_SHA" > "$BACKUP_DIR/source-commit.txt"
echo "BACKUP_OK=$BACKUP_DIR"
docker rename taha-ai "$ROLLBACK"
docker update --restart=no "$ROLLBACK" >/dev/null
docker run -d --name taha-ai --restart always --network "$NETWORK" -p 127.0.0.1:8787:8787 \
  -v "$DATA:/data" -v "$ENV_FILE:/app/.dev.vars:ro" "$NEW_IMAGE" >/dev/null
probe 8787 || { echo 'PRODUCTION_PROBE_FAILED'; exit 27; }
image_probe 8787 || { echo 'PRODUCTION_IMAGE_ENCODER_FAILED'; exit 29; }
docker tag "$NEW_IMAGE" "${IMAGE_REPO}:latest"
if [ "$TIMER_WAS_ACTIVE" = yes ]; then
  systemctl start taha-ai-cron.timer
  systemctl is-active --quiet taha-ai-cron.timer
  echo 'CRON_ACTIVE=yes'
else
  ! systemctl is-active --quiet taha-ai-cron.timer
  echo 'CRON_PRESERVED_INACTIVE=yes'
fi
RELEASE_OK=yes
echo 'PRODUCTION_AUTHENTICATED_UI_OK=yes'
echo "FINAL_REPO=$(git -C "$REPO" rev-parse HEAD)"
echo "FINAL_IMAGE=$(docker inspect taha-ai -f '{{.Config.Image}}')"
echo "ROLLBACK_CONTAINER=$ROLLBACK"
