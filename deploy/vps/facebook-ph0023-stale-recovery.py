"""Republish only the PH0023 Facebook job scheduled for 2026-09-09 12:00 Asia/Ho_Chi_Minh."""
from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

WORKSPACE = "00000000-0000-4000-8000-000000000001"
SKU = "PH0023"
LOCAL_MINUTE = "2026-09-09 12:00"
MARKER = "product-copy-v2-compat-20260909"
REPO = Path("/var/www/taha-ai")
ENV = Path("/etc/taha-ai/.dev.vars")
BACKUP_DIR = Path("/var/backups/taha-ai")


def require(value: object, code: str) -> None:
    if not value:
        raise RuntimeError(code)


def command(args: list[str], timeout: int = 90) -> bytes:
    result = subprocess.run(args, capture_output=True, timeout=timeout)
    require(result.returncode == 0, "PH0023_RECOVERY_COMMAND_FAILED")
    return result.stdout


def query(sql: str) -> list[dict]:
    raw = command([
        "docker", "exec", "taha-ai", "pnpm", "exec", "wrangler", "d1", "execute", "DB",
        "--local", "--persist-to=/data", "--config=/app/wrangler.vps.jsonc",
        "--json", "--command", sql,
    ], timeout=120)
    try:
        payload = json.loads(raw)
        rows = payload[0]["results"]
    except (ValueError, IndexError, KeyError, TypeError):
        raise RuntimeError("PH0023_RECOVERY_QUERY_INVALID") from None
    require(isinstance(rows, list), "PH0023_RECOVERY_QUERY_INVALID")
    return rows


def target_rows() -> list[dict]:
    return query(f"""SELECT j.id,j.status,j.draft_id AS draftId,j.schedule_id AS scheduleId,
      j.connection_id AS connectionId,j.product_id AS productId,j.scheduled_for AS scheduledFor,
      COALESCE(j.error_code,'') AS errorCode,COALESCE(j.error_message,'') AS errorMessage,
      COALESCE(j.external_post_id,'') AS externalPostId,COALESCE(j.external_url,'') AS externalUrl,
      COALESCE(j.provider_response_json,'{{}}') AS providerResponse,j.available_at AS availableAt,
      COALESCE(json_extract(j.payload_snapshot_json,'$.platformData.fingerprintRecovery'),'') AS marker,
      COALESCE(json_extract(j.payload_snapshot_json,'$.platformData.sourceFingerprintVersion'),'') AS fingerprintVersion,
      COALESCE(json_extract(j.payload_snapshot_json,'$.platformData.contentTemplateVersion'),'') AS templateVersion,
      c.status AS connectionStatus,c.publish_mode AS publishMode,
      (SELECT COUNT(*) FROM product_articles a WHERE a.workspace_id=j.workspace_id AND a.product_id=j.product_id) AS articleCount
    FROM publish_jobs j
    JOIN products p ON p.id=j.product_id AND p.workspace_id=j.workspace_id
    JOIN channel_connections c ON c.id=j.connection_id AND c.workspace_id=j.workspace_id
    WHERE j.workspace_id='{WORKSPACE}' AND p.base_sku='{SKU}' AND c.provider='facebook'
      AND strftime('%Y-%m-%d %H:%M',j.scheduled_for/1000,'unixepoch','+7 hours')='{LOCAL_MINUTE}'
      AND (
        (j.status='blocked' AND j.error_code='PRODUCT_CONTENT_STALE' AND j.external_post_id IS NULL
          AND COALESCE(j.provider_response_json,'{{}}')='{{}}')
        OR (j.status='published' AND j.external_post_id IS NOT NULL)
        OR json_extract(j.payload_snapshot_json,'$.platformData.fingerprintRecovery')='{MARKER}'
      )
    ORDER BY j.created_at DESC""")


def job_row(job_id: str) -> dict:
    safe = job_id.replace("'", "''")
    rows = query(f"""SELECT id,status,draft_id AS draftId,COALESCE(error_code,'') AS errorCode,
      COALESCE(external_post_id,'') AS externalPostId,COALESCE(external_url,'') AS externalUrl,
      available_at AS availableAt,
      COALESCE(json_extract(payload_snapshot_json,'$.platformData.fingerprintRecovery'),'') AS marker
    FROM publish_jobs WHERE workspace_id='{WORKSPACE}' AND id='{safe}' LIMIT 1""")
    require(len(rows) == 1, "PH0023_RECOVERY_JOB_CHANGED")
    return rows[0]


def write_backup(row: dict) -> None:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    safe_id = re.sub(r"[^A-Za-z0-9_.-]", "_", str(row["id"]))
    path = BACKUP_DIR / f"ph0023-facebook-1200-before-{safe_id}.json"
    if path.exists():
        return
    full = query(f"""SELECT * FROM publish_jobs WHERE workspace_id='{WORKSPACE}'
      AND id='{str(row['id']).replace("'", "''")}' LIMIT 1""")
    require(len(full) == 1, "PH0023_RECOVERY_BACKUP_SOURCE_CHANGED")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        json.dump(full[0], output, ensure_ascii=False)
        output.flush()
        os.fsync(output.fileno())


def requeue(job_id: str) -> None:
    safe = job_id.replace("'", "''")
    rows = query(f"""UPDATE publish_jobs SET status='queued',available_at=unixepoch()*1000,
      attempt_count=0,lease_owner=NULL,lease_expires_at=NULL,error_code=NULL,error_message=NULL,
      completed_at=NULL,updated_at=unixepoch()*1000,
      payload_snapshot_json=json_set(payload_snapshot_json,
        '$.platformData.fingerprintRecovery','{MARKER}')
    WHERE id='{safe}' AND workspace_id='{WORKSPACE}' AND status='blocked'
      AND error_code='PRODUCT_CONTENT_STALE' AND external_post_id IS NULL
      AND COALESCE(provider_response_json,'{{}}')='{{}}'
    RETURNING id,status""")
    require(len(rows) == 1 and rows[0]["status"] == "queued", "PH0023_RECOVERY_REQUEUE_REJECTED")


def remove_recovery_marker(job_id: str, draft_id: str | None) -> None:
    safe_job = job_id.replace("'", "''")
    rows = query(f"""UPDATE publish_jobs
      SET payload_snapshot_json=json_remove(payload_snapshot_json,'$.platformData.fingerprintRecovery'),
          updated_at=unixepoch()*1000
      WHERE id='{safe_job}' AND workspace_id='{WORKSPACE}' AND status='published'
        AND external_post_id IS NOT NULL
      RETURNING id""")
    require(len(rows) == 1, "PH0023_RECOVERY_MARKER_CLEANUP_REJECTED")
    if draft_id:
        safe_draft = draft_id.replace("'", "''")
        query(f"""UPDATE content_drafts
          SET platform_data_json=json_remove(platform_data_json,'$.fingerprintRecovery'),
              updated_at=unixepoch()*1000
          WHERE id='{safe_draft}' AND workspace_id='{WORKSPACE}'
            AND json_extract(platform_data_json,'$.fingerprintRecovery')='{MARKER}'
          RETURNING id""")


def read_secret() -> str:
    require(ENV.is_file() and not ENV.is_symlink(), "PH0023_RECOVERY_ENV_INVALID")
    for line in ENV.read_text(encoding="utf-8").splitlines():
        key, separator, value = line.partition("=")
        if separator and key.strip() == "INTERNAL_API_SECRET":
            secret = value.strip().strip("\"'")
            require(secret, "PH0023_RECOVERY_SECRET_MISSING")
            return secret
    raise RuntimeError("PH0023_RECOVERY_SECRET_MISSING")


def tick(secret: str, job_id: str) -> dict:
    request = Request(
        "http://127.0.0.1:8787/api/internal/publish/tick",
        method="POST",
        data=json.dumps({"jobIds": [job_id]}).encode(),
        headers={"Authorization": "Bearer " + secret, "Content-Type": "application/json"},
    )
    try:
        with urlopen(request, timeout=360) as response:
            payload = json.load(response)
    except HTTPError as error:
        raise RuntimeError("PH0023_RECOVERY_API_HTTP_" + str(error.code)) from None
    except (OSError, ValueError):
        raise RuntimeError("PH0023_RECOVERY_API_UNAVAILABLE") from None
    try:
        result = payload["data"]["dispatcher"]
    except (KeyError, TypeError):
        raise RuntimeError("PH0023_RECOVERY_API_INVALID") from None
    require(isinstance(result, dict), "PH0023_RECOVERY_API_INVALID")
    return result


def wait_for_cron_idle() -> None:
    for _ in range(90):
        state = command(["systemctl", "show", "-p", "ActiveState", "--value", "taha-ai-cron.service"]).strip()
        if state not in (b"active", b"activating", b"deactivating"):
            return
        time.sleep(2)
    raise RuntimeError("PH0023_RECOVERY_CRON_BUSY")


def main(args: argparse.Namespace) -> None:
    require(re.fullmatch(r"[0-9a-f]{40}", args.expected_release_sha), "PH0023_RECOVERY_RELEASE_REQUIRED")
    require(command(["git", "-C", str(REPO), "rev-parse", "HEAD"]).decode().strip() == args.expected_release_sha,
            "PH0023_RECOVERY_RELEASE_CHANGED")
    app = json.loads(command(["docker", "inspect", "taha-ai"]))[0]
    require(app["Config"]["Image"] == "tahashoes-taha-ai:" + args.expected_release_sha
            and app["State"]["Running"], "PH0023_RECOVERY_APP_CHANGED")
    secret = read_secret()

    with open("/var/lock/taha-ai-release.lock", "a", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        timer_was_active = subprocess.run(
            ["systemctl", "is-active", "--quiet", "taha-ai-cron.timer"],
            capture_output=True, timeout=10,
        ).returncode == 0
        command(["systemctl", "stop", "taha-ai-cron.timer"])
        try:
            wait_for_cron_idle()
            rows = target_rows()
            require(len(rows) == 1, "PH0023_RECOVERY_TARGET_COUNT_INVALID")
            row = rows[0]
            require(row["connectionStatus"] == "connected" and row["publishMode"] == "api",
                    "PH0023_RECOVERY_CONNECTION_INVALID")
            print("PH0023_RECOVERY_TARGET=" + json.dumps({
                "sku": SKU, "localMinute": LOCAL_MINUTE, "jobId": row["id"], "status": row["status"],
                "errorCode": row["errorCode"], "fingerprintVersion": row["fingerprintVersion"],
                "templateVersion": row["templateVersion"], "articleCount": row["articleCount"],
            }, separators=(",", ":")), flush=True)

            if row["status"] != "published":
                require(row["status"] == "blocked" and row["errorCode"] == "PRODUCT_CONTENT_STALE",
                        "PH0023_RECOVERY_TARGET_CHANGED")
                write_backup(row)
                requeue(row["id"])
                deadline = time.monotonic() + 10 * 60
                previous = None
                while True:
                    require(time.monotonic() < deadline, "PH0023_RECOVERY_TIMEOUT")
                    row = job_row(row["id"])
                    state = {"status": row["status"], "errorCode": row["errorCode"]}
                    if state != previous:
                        print("PH0023_RECOVERY_PROGRESS=" + json.dumps(state, separators=(",", ":")), flush=True)
                        previous = state
                    if row["status"] == "published":
                        require(row["externalPostId"], "PH0023_RECOVERY_RECEIPT_MISSING")
                        break
                    require(row["status"] in ("queued", "retry_wait", "publishing"),
                            "PH0023_RECOVERY_PUBLISH_FAILED")
                    if row["status"] != "publishing" and int(row["availableAt"] or 0) <= int(time.time() * 1000):
                        result = tick(secret, row["id"])
                        errors = result.get("errors") if isinstance(result.get("errors"), list) else []
                        if errors:
                            print("PH0023_RECOVERY_WORKER_ERRORS=" + json.dumps(errors, separators=(",", ":")), flush=True)
                    time.sleep(2)

            remove_recovery_marker(row["id"], row.get("draftId"))
            row = job_row(row["id"])
            require(row["status"] == "published" and row["externalPostId"] and not row["marker"],
                    "PH0023_RECOVERY_FINAL_STATE_INVALID")
            print("PH0023_RECOVERY_COMPLETE=" + json.dumps({
                "sku": SKU, "jobId": row["id"], "externalPostId": row["externalPostId"],
                "externalUrl": row["externalUrl"], "markerRemoved": True,
            }, separators=(",", ":")), flush=True)
        finally:
            if timer_was_active:
                command(["systemctl", "enable", "--now", "taha-ai-cron.timer"])
                require(subprocess.run(
                    ["systemctl", "is-active", "--quiet", "taha-ai-cron.timer"],
                    capture_output=True, timeout=10,
                ).returncode == 0, "PH0023_RECOVERY_TIMER_RESTART_FAILED")
                print("PH0023_RECOVERY_TIMER_ACTIVE=yes", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-release-sha", required=True)
    try:
        main(parser.parse_args())
    except Exception as error:
        message = str(error)
        print(message if re.fullmatch(r"PH0023_RECOVERY_[A-Z0-9_]+", message) else "PH0023_RECOVERY_FAILED", file=sys.stderr)
        raise SystemExit(1)
