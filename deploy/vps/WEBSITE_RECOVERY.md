# Bounded website recovery

The validated main release runs this recovery only for the authorized
`[website-trial-PH0015]` commit marker, under shared `taha-vps-production` concurrency.
It first reclaims obsolete stopped releases while retaining the active image and
three newest rollback containers, then deploys the app and runs `website-recovery.py`.
The installer pins the diagnosed backend and stages Go tests without a network.
Run only reviewed code from `main`. Do not accept a
user-supplied script, branch or command in a workflow with VPS secrets.

1. Run `vps-website-diagnose.yml` and review every section. An unavailable section
   is unknown, never evidence of an empty backlog. Preserve the container ID and
   image ID, exact PH0015 run/job state, receiver hashes, cron state and website
   backlog/daily-automation counts.
2. Deploy/test the reviewed receiver before enabling its secret. The repair
   expects source SHA-256
   `5b18f176dbee8ec72aafb8b6bb5c451d64fb2b04ff74ce88dc96597019628b2a`
   in the running image and the compiled product handler symbol. Re-diagnose
   after replacement to obtain the current container/image IDs.
3. Make `website-state-diagnose.mjs`, `website-connection-secret.mjs`,
   `website-runtime-repair.py`, and `website-one-product-trial.py` available in one
   trusted directory on the host. The secret helper's stdout must only be
   captured privately by the Python repair script; never run it as a standalone
   Actions step or print its result.
4. Run `python3 website-runtime-repair.py --expected-container-id <diagnosed-id>
   --expected-image-id <diagnosed-image-id>` without `--apply`. This checks
   eligibility and drift. It does **not** prove the prospective Compose wiring;
   that check happens after the reversible env edit, before any recreation.
5. When live evidence permits, rerun the same command with `--apply`. The script
   refuses nonempty differing secrets, ambiguous env syntax, image/config drift,
   enabled daily website automation/backfill, or active website work. It changes
   only the backend env file and recreates only `backend`, using the same image
   with `--no-deps --no-build --pull never`. A private backup of the original env
   is retained. A wiring, runtime or signed rejection-probe failure restores the
   original env and container configuration; concurrent env edits stop rollback
   to avoid overwriting another operator's work.
   Compose v2 is detected from either `docker compose` or the standalone
   `docker-compose`; the same selected CLI is used for repair and rollback.
   An unset backfill flag is accepted because the app enables it only for the
   literal value `1`. No backfill environment setting or cron state is changed.
6. Deploy the scoped `/api/internal/website/deliver` endpoint before attempting a
   trial. Run `python3 website-one-product-trial.py` to inspect eligibility, then
   use `--apply` for the authorized trial. It uses only product PH0015, connection
   `de367230-7460-4964-ba4c-5754819efce6`, zero generated images, and the original
   key `owner-website-trial-PH0015-2026-09-08-v1`. Existing published output is
   returned; uncertain or attempted output stops for receipt review.

The trial calls only the filtered automation worker and the scoped website
delivery endpoint. It never invokes the global cron, resets a run/job, changes
other schedules or stops/restarts cron. It therefore also works while cron is
held by the deployment procedure. Independently verify the returned public
product URL, SKU, sizes, copy and images before considering the trial complete.

On timeout or an unknown API outcome, run the read-only diagnosis before any
further action. Never use a new idempotency key to bypass a stopped trial.

Validation:

```bash
python3 -m unittest discover -s tests -p vps_website_ops_test.py -v
node --test tests/website-scoped-delivery.test.mjs
```
