# TAHA runtime guard

This host-side mitigation addresses the confirmed failure mode in issue #37: the application worker dies after an OOM event while the wrapper leaves the Docker container running. It does **not** claim to fix the source of memory growth.

## Scope

- Deployed independently from the application image. It does not run migrations, edit the product catalog, requeue jobs, publish posts, change templates, rewrite Nginx authentication, or delete Docker resources.
- Runs from `/usr/local/lib/taha-ai/runtime-guard.py` under `taha-ai-runtime-guard.service`, triggered by `taha-ai-runtime-guard.timer` approximately once per minute.
- Reads the existing internal credential locally. It never prints credentials and refuses HTTP redirects for the credential-bearing probe.
- Checks the authenticated `/api/integrations` route and records process-name/RSS metrics in journald. An unavailable optional metrics command is not considered an application failure.

## Recovery conditions: all required

1. Exact application image repository/tag, runtime mounts and source checkout agree.
2. No deployment holds `/var/lock/taha-ai-release.lock`.
3. Three probes receive no HTTP response; HTTP errors including 401/403/404/500 are **not** treated as this dead-runtime condition.
4. Container is running, its OOM marker is true, and its own network namespace has no listener on port 8787.
5. No active/activating cron service and no active or unknown-expiry publish/automation lease.
6. No prior failed-recovery latch, at least 10 minutes since the previous guard restart, fewer than two attempts in the trailing hour.

After rechecking under the lock with cron paused, preserve private evidence and restart the **same container once**. Restore only a previously active cron timer, after authenticated health checks pass. A failed recovery is latched and the timer stays paused for investigation. The guard does not repair failed publishing states.

## Operator controls

Read-only checks:

```sh
sudo python3 -B /usr/local/lib/taha-ai/runtime-guard.py --check-only
sudo systemctl status taha-ai-runtime-guard.timer
sudo journalctl -u taha-ai-runtime-guard.service --since '30 minutes ago' --no-pager
```

Pause auto-recovery without changing application state:

```sh
sudo touch /etc/taha-ai/runtime-guard.disabled
sudo systemctl stop taha-ai-runtime-guard.timer
```

State is private under `/var/lib/taha-ai-runtime-guard/state.json`. Do not delete a failure latch or resume a paused cron timer before reviewing application health and outstanding provider receipts. An intentional source/image mismatch also requires review, not weakening identity checks.

## Validation

```sh
PYTHONWARNINGS=error::ResourceWarning python3 -B -m unittest discover -s tests -p 'test_runtime_guard*.py' -v
```

22 tests cover positive OOM detection, responsive/error HTTP exclusions, PID/listener checks, active/null-expiry leases, container changes, cooldown, hourly limit, failure latch, timer preservation and optional telemetry. Production validation uses check-only probes and real healthy timer executions. No deliberate OOM or artificial production restart is used to test the guard.

## Remaining investigation

Collect RAM trends under real media/cron/sync load and determine the allocation path or runtime behavior causing growth. Consider bounded media concurrency and the suitability of the current Wrangler/workerd runtime only after measurement. Do not silently change the publishing worker, token handling or data storage during outage recovery. The VPS was observed with about 4 GB RAM, no swap and about 4.2 GB disk free; neither capacity nor swap has been changed by this mitigation.
