"""Free only unreferenced TAHA images or an obsolete rollback while preserving live data."""
from __future__ import annotations

import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys

REPOSITORY = "tahashoes-taha-ai"
MIN_FREE_BYTES = 6 * 1024 * 1024 * 1024
BACKUP_DIR = Path("/var/backups/taha-ai")


def fail(code: str) -> None:
    raise RuntimeError(code)


def run(*args: str, timeout: int = 120, check: bool = True) -> str:
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode != 0:
        fail("EMERGENCY_SPACE_COMMAND_FAILED")
    return result.stdout


def docker(*args: str, timeout: int = 120) -> str:
    return run("docker", *args, timeout=timeout)


def inspect(kind: str, reference: str) -> dict:
    try:
        value = json.loads(docker(kind, "inspect", reference))
        if not isinstance(value, list) or len(value) != 1:
            fail("EMERGENCY_SPACE_INSPECT_INVALID")
        return value[0]
    except (ValueError, KeyError, TypeError):
        fail("EMERGENCY_SPACE_INSPECT_INVALID")


def container_inventory() -> list[dict]:
    ids = docker("container", "ls", "-aq").split()
    if not ids:
        return []
    try:
        value = json.loads(docker("container", "inspect", *ids))
        if not isinstance(value, list):
            fail("EMERGENCY_SPACE_CONTAINER_INVENTORY_INVALID")
        return value
    except (ValueError, TypeError):
        fail("EMERGENCY_SPACE_CONTAINER_INVENTORY_INVALID")


def image_inventory() -> list[dict]:
    ids = sorted(set(docker("image", "ls", "-aq", "--no-trunc").split()))
    images: list[dict] = []
    for identity in ids:
        image = inspect("image", identity)
        tags = image.get("RepoTags") or []
        labels = image.get("Config", {}).get("Labels") or {}
        owned = any(tag.startswith(REPOSITORY + ":") for tag in tags) or labels.get("org.opencontainers.image.title") == "taha-ai"
        if owned:
            images.append(image)
    return images


def free_bytes() -> int:
    stats = os.statvfs("/")
    return stats.f_bavail * stats.f_frsize


def write_backup(name: str, payload: dict) -> None:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    path = BACKUP_DIR / name
    if path.exists():
        return
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        json.dump(payload, output, ensure_ascii=False)
        output.flush()
        os.fsync(output.fileno())


def remove_image(image: dict, containers: list[dict]) -> bool:
    image_id = str(image.get("Id") or "")
    if not image_id or any(item.get("Image") == image_id for item in containers):
        return False
    tags = [str(tag) for tag in (image.get("RepoTags") or [])]
    if any(not tag.startswith(REPOSITORY + ":") for tag in tags):
        return False
    write_backup("emergency-unused-image-" + image_id.removeprefix("sha256:")[:12] + ".json", image)
    for tag in tags:
        run("docker", "image", "rm", tag, timeout=180, check=False)
    if image_id in set(docker("image", "ls", "-aq", "--no-trunc").split()):
        result = subprocess.run(["docker", "image", "rm", image_id], capture_output=True, text=True, timeout=180)
        if result.returncode != 0:
            return False
    print("EMERGENCY_SPACE_IMAGE_REMOVED=" + image_id, flush=True)
    return True


def remove_oldest_extra_rollback(containers: list[dict]) -> bool:
    rollbacks = [item for item in containers if re.fullmatch(r"/taha-ai-rollback-\d{8}-\d{6}(?:-\d+)?", str(item.get("Name") or ""))]
    rollbacks.sort(key=lambda item: str(item.get("Created") or ""), reverse=True)
    if len(rollbacks) <= 3:
        return False
    candidate = rollbacks[-1]
    if candidate.get("State", {}).get("Status") != "exited" or candidate.get("HostConfig", {}).get("RestartPolicy", {}).get("Name") != "no":
        return False
    refs = (candidate.get("HostConfig", {}).get("VolumesFrom") or []) + (candidate.get("HostConfig", {}).get("Links") or [])
    if refs:
        return False
    candidate_id = str(candidate.get("Id") or "")
    image_id = str(candidate.get("Image") or "")
    write_backup("emergency-obsolete-rollback-" + candidate_id[:12] + ".json", candidate)
    docker("container", "rm", candidate_id)
    print("EMERGENCY_SPACE_ROLLBACK_REMOVED=" + str(candidate.get("Name") or ""), flush=True)
    remaining = container_inventory()
    if image_id and not any(item.get("Image") == image_id for item in remaining):
        try:
            remove_image(inspect("image", image_id), remaining)
        except RuntimeError:
            pass
    return True


def main() -> None:
    with open("/var/lock/taha-ai-release.lock", "a", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        current = inspect("container", "taha-ai")
        if current.get("Name") != "/taha-ai" or current.get("State", {}).get("Status") != "running":
            fail("EMERGENCY_SPACE_LIVE_APP_UNHEALTHY")
        current_id = str(current.get("Id") or "")
        current_image = str(current.get("Image") or "")
        before = free_bytes()
        print("EMERGENCY_SPACE_BEFORE_BYTES=" + str(before), flush=True)

        containers = container_inventory()
        referenced = {str(item.get("Image") or "") for item in containers}
        unused = [image for image in image_inventory() if str(image.get("Id") or "") not in referenced]
        unused.sort(key=lambda image: (
            0 if any("f3018003e4b091a39abdad14a13e7a5e0c449a59" in tag for tag in (image.get("RepoTags") or [])) else 1,
            str(image.get("Created") or ""),
        ))
        for image in unused:
            if free_bytes() >= MIN_FREE_BYTES:
                break
            remove_image(image, container_inventory())

        while free_bytes() < MIN_FREE_BYTES:
            if not remove_oldest_extra_rollback(container_inventory()):
                break

        after = free_bytes()
        live = inspect("container", "taha-ai")
        if str(live.get("Id") or "") != current_id or str(live.get("Image") or "") != current_image or live.get("State", {}).get("Status") != "running":
            fail("EMERGENCY_SPACE_LIVE_APP_CHANGED")
        if subprocess.run(["systemctl", "is-active", "--quiet", "taha-ai-cron.timer"], timeout=15).returncode != 0:
            fail("EMERGENCY_SPACE_TIMER_INACTIVE")
        print("EMERGENCY_SPACE_AFTER_BYTES=" + str(after), flush=True)
        if after < MIN_FREE_BYTES:
            fail("EMERGENCY_SPACE_STILL_LOW")
        print("EMERGENCY_SPACE_READY=yes", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        message = str(error)
        print(message if re.fullmatch(r"EMERGENCY_SPACE_[A-Z0-9_]+", message) else "EMERGENCY_SPACE_FAILED", file=sys.stderr)
        raise SystemExit(1)
