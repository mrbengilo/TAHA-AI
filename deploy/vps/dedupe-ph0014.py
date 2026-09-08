"""Keep the one published PH0014 Facebook record and remove internal duplicates."""
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time

WORKSPACE = "00000000-0000-4000-8000-000000000001"
SKU = "PH0014"
KEEP_DRAFT_ID = "draft_a332146580c96a0b3d4aa19998920a0439860a82"
KEEP_EXTERNAL_POST_ID = "1015096011692783_122121496239193948"
EXACT_RUN_ID = "100bc4a8-d722-4229-90c2-5fde84eb9327"
REVISION = "4ef44959e6ffd29d966136922e3857c6a2119b86"
LOCK = Path("/var/lock/taha-ai-release.lock")
RECOVERY = Path("/var/lib/taha-ai/ops-recovery")


def command(*args, check=True, timeout=30):
    return subprocess.run(args, check=check, capture_output=True, text=True, timeout=timeout)


def validate_runtime():
    runtime = command(
        "docker", "inspect", "taha-ai", "--format",
        '{{.Config.Image}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.State.Status}}',
    ).stdout.strip()
    expected = f"tahashoes-taha-ai:{REVISION}|{REVISION}|running"
    if runtime != expected:
        raise RuntimeError("PH0014_DEDUPE_REVISION_MISMATCH")


def find_database():
    required = {
        "products", "content_drafts", "content_draft_media", "schedules",
        "publish_jobs", "automation_runs", "automation_steps",
    }
    matches = []
    for path in Path("/var/lib/taha-ai").rglob("*.sqlite"):
        try:
            with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as db:
                tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if not required.issubset(tables):
                    continue
                total = db.execute(
                    "SELECT count(*) FROM products WHERE workspace_id=? AND base_sku=?",
                    (WORKSPACE, SKU),
                ).fetchone()[0]
                if total == 1:
                    matches.append(path)
        except sqlite3.Error:
            continue
    if len(matches) != 1:
        raise RuntimeError("PH0014_DEDUPE_DATABASE_AMBIGUOUS")
    return matches[0]


def backup_database(database):
    RECOVERY.mkdir(parents=True, exist_ok=True, mode=0o700)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    destination = RECOVERY / f"ph0014-before-dedupe-{stamp}.sqlite"
    if destination.exists():
        raise RuntimeError("PH0014_DEDUPE_BACKUP_COLLISION")
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as source:
        with sqlite3.connect(destination) as target:
            source.backup(target)
    os.chmod(destination, 0o600)
    with destination.open("rb") as handle:
        os.fsync(handle.fileno())
    return destination


def body_hash(value):
    return hashlib.sha256((value or "").encode()).hexdigest()


def dedupe(database):
    now = int(time.time() * 1000)
    with sqlite3.connect(database, timeout=60) as db:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("BEGIN IMMEDIATE")
        try:
            product = db.execute(
                "SELECT id FROM products WHERE workspace_id=? AND base_sku=?",
                (WORKSPACE, SKU),
            ).fetchall()
            if len(product) != 1:
                raise RuntimeError("PH0014_DEDUPE_PRODUCT_AMBIGUOUS")
            product_id = product[0]["id"]
            keep = db.execute(
                "SELECT d.id,d.target_provider,d.content_type,d.status,j.status AS job_status,j.external_post_id "
                "FROM content_drafts d JOIN publish_jobs j ON j.draft_id=d.id AND j.workspace_id=d.workspace_id "
                "WHERE d.id=? AND d.workspace_id=? AND d.product_id=?",
                (KEEP_DRAFT_ID, WORKSPACE, product_id),
            ).fetchall()
            if len(keep) != 1 or keep[0]["target_provider"] != "facebook" \
                    or keep[0]["content_type"] != "social_post" or keep[0]["status"] != "approved" \
                    or keep[0]["job_status"] != "published" \
                    or keep[0]["external_post_id"] != KEEP_EXTERNAL_POST_ID:
                raise RuntimeError("PH0014_DEDUPE_KEEP_RECORD_CHANGED")

            exact = db.execute(
                "SELECT r.id,r.status,r.request_key FROM automation_runs r "
                "JOIN products p ON p.id=r.product_id AND p.workspace_id=r.workspace_id "
                "WHERE r.id=? AND r.workspace_id=? AND p.base_sku=?",
                (EXACT_RUN_ID, WORKSPACE, SKU),
            ).fetchall()
            if len(exact) != 1 or not exact[0]["request_key"].endswith(":exact-sku-size-v1:PH0014"):
                raise RuntimeError("PH0014_DEDUPE_EXACT_RUN_CHANGED")

            drafts = [dict(row) for row in db.execute(
                "SELECT id,target_provider,content_type,status,body,created_at FROM content_drafts "
                "WHERE workspace_id=? AND product_id=? ORDER BY created_at,id",
                (WORKSPACE, product_id),
            )]
            delete_ids = [row["id"] for row in drafts if row["id"] != KEEP_DRAFT_ID]
            if not delete_ids:
                if len(drafts) != 1:
                    raise RuntimeError("PH0014_DEDUPE_FINAL_COUNT_INVALID")
            else:
                placeholders = ",".join("?" for _ in delete_ids)
                unsafe = db.execute(
                    f"SELECT id,status,external_post_id FROM publish_jobs WHERE workspace_id=? "
                    f"AND draft_id IN ({placeholders}) AND (status IN ('publishing','published') OR external_post_id IS NOT NULL)",
                    [WORKSPACE, *delete_ids],
                ).fetchall()
                if unsafe:
                    raise RuntimeError("PH0014_DEDUPE_EXTERNAL_POST_PRESENT")

                schedule_ids = [row[0] for row in db.execute(
                    f"SELECT id FROM schedules WHERE workspace_id=? AND draft_id IN ({placeholders})",
                    [WORKSPACE, *delete_ids],
                )]
                if schedule_ids:
                    schedule_placeholders = ",".join("?" for _ in schedule_ids)
                    db.execute(
                        f"DELETE FROM publish_jobs WHERE workspace_id=? AND "
                        f"(draft_id IN ({placeholders}) OR schedule_id IN ({schedule_placeholders}))",
                        [WORKSPACE, *delete_ids, *schedule_ids],
                    )
                else:
                    db.execute(
                        f"DELETE FROM publish_jobs WHERE workspace_id=? AND draft_id IN ({placeholders})",
                        [WORKSPACE, *delete_ids],
                    )
                db.execute(
                    f"DELETE FROM schedules WHERE workspace_id=? AND draft_id IN ({placeholders})",
                    [WORKSPACE, *delete_ids],
                )
                db.execute(
                    f"DELETE FROM content_draft_media WHERE workspace_id=? AND draft_id IN ({placeholders})",
                    [WORKSPACE, *delete_ids],
                )
                db.execute(
                    f"DELETE FROM content_drafts WHERE workspace_id=? AND id IN ({placeholders})",
                    [WORKSPACE, *delete_ids],
                )

            db.execute(
                "UPDATE automation_steps SET status='cancelled',error_code='PH0014_DUPLICATE_SUPPRESSED',"
                "error_message='Đã giữ lại một bài PH0014 đã đăng.',lease_owner=NULL,lease_expires_at=NULL,"
                "completed_at=COALESCE(completed_at,?),updated_at=? "
                "WHERE workspace_id=? AND run_id=? AND status!='completed'",
                (now, now, WORKSPACE, EXACT_RUN_ID),
            )
            db.execute(
                "UPDATE automation_runs SET status='cancelled',error_code='PH0014_DUPLICATE_SUPPRESSED',"
                "error_message='Đã giữ lại một bài PH0014 đã đăng.',completed_at=?,updated_at=? "
                "WHERE workspace_id=? AND id=? AND status!='cancelled'",
                (now, now, WORKSPACE, EXACT_RUN_ID),
            )

            remaining = db.execute(
                "SELECT id,target_provider,status FROM content_drafts WHERE workspace_id=? AND product_id=?",
                (WORKSPACE, product_id),
            ).fetchall()
            if len(remaining) != 1 or remaining[0]["id"] != KEEP_DRAFT_ID \
                    or remaining[0]["target_provider"] != "facebook" or remaining[0]["status"] != "approved":
                raise RuntimeError("PH0014_DEDUPE_FINAL_COUNT_INVALID")
            run_state = db.execute(
                "SELECT status,error_code FROM automation_runs WHERE workspace_id=? AND id=?",
                (WORKSPACE, EXACT_RUN_ID),
            ).fetchone()
            if not run_state or tuple(run_state) != ("cancelled", "PH0014_DUPLICATE_SUPPRESSED"):
                raise RuntimeError("PH0014_DEDUPE_CANCEL_FAILED")
            db.commit()
        except Exception:
            db.rollback()
            raise

    audit = {
        "sku": SKU,
        "keptDraftId": KEEP_DRAFT_ID,
        "keptExternalPostId": KEEP_EXTERNAL_POST_ID,
        "removed": [
            {
                "id": row["id"],
                "provider": row["target_provider"],
                "contentType": row["content_type"],
                "status": row["status"],
                "bodySha256": body_hash(row["body"]),
            }
            for row in drafts if row["id"] != KEEP_DRAFT_ID
        ],
        "exactRunCancelled": EXACT_RUN_ID,
        "completedAt": now,
    }
    audit_path = RECOVERY / f"ph0014-dedupe-{now}.json"
    audit_path.write_text(json.dumps(audit, ensure_ascii=False, separators=(",", ":")))
    os.chmod(audit_path, 0o600)
    return audit, audit_path


def restore_cron_after_accelerator_exits(timeout_seconds=600):
    deadline = time.monotonic() + timeout_seconds
    with LOCK.open("a") as lock:
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("PH0014_DEDUPE_RELEASE_LOCK_TIMEOUT")
                time.sleep(5)
        command("systemctl", "start", "taha-ai-cron.timer")
        if command("systemctl", "is-active", "--quiet", "taha-ai-cron.timer", check=False).returncode != 0:
            raise RuntimeError("PH0014_DEDUPE_CRON_RESTORE_FAILED")


def main():
    validate_runtime()
    database = find_database()
    backup = backup_database(database)
    audit, audit_path = dedupe(database)
    restore_cron_after_accelerator_exits()
    validate_runtime()
    print("PH0014_DEDUPE_OK=yes")
    print("PH0014_DEDUPE_REMOVED=" + str(len(audit["removed"])))
    print("PH0014_DEDUPE_KEPT=" + KEEP_DRAFT_ID)
    print("PH0014_DEDUPE_EXTERNAL_POST=" + KEEP_EXTERNAL_POST_ID)
    print("PH0014_DEDUPE_BACKUP=" + str(backup))
    print("PH0014_DEDUPE_AUDIT=" + str(audit_path))
    print("PH0014_DEDUPE_CRON_ACTIVE=yes")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        value = str(error)
        print(value if value.startswith("PH0014_DEDUPE_") else "PH0014_DEDUPE_FAILED", file=sys.stderr)
        raise SystemExit(1)
