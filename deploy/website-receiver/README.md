# TAHA product receiver adapter

This adapter extends the existing `POST /api/taha/publish` route. It keeps the
legacy `website_article` behavior and adds strict handling for
`taha.website.product.v1` / `upsert_product`.

## Installation hook

From the `gosporty-backend` root:

1. Copy `product_receiver.go` to `handlers/product_receiver.go`.
2. Copy `product_receiver_test.go` to `handlers/product_receiver_test.go` for the
   staged build/test, or retain it in the backend repository.
3. Apply `article_hook.patch`. The only hook belongs in
   `PublishWebsiteArticle`, immediately after the existing idempotency-header
   validation and before `var payload websiteArticlePayload`.
4. Run `gofmt -w handlers/article.go handlers/product_receiver.go handlers/product_receiver_test.go`.
5. Run `go test ./handlers` and build the normal backend image.

The hook intentionally runs after the existing handler reads the raw request
body and calls `validWebsiteSignature`. It therefore authenticates the exact
bytes the sender signed and avoids a second read or JSON re-encoding. A body
without `schemaVersion` returns to the unchanged article decoder.

The adapter stores idempotency reservations in `taha_product_receipts`, whose
built-in Mongo `_id` uniqueness protects each key without a new index. A key is
bound to its raw-body digest, exact SKU, and product ObjectID before media or
product writes begin. New product ObjectIDs are deterministically derived from
the exact uppercase SKU. Before creating one, the adapter also searches legacy
product names and slugs for the SKU at alphanumeric boundaries; one match is
adopted, while multiple matches fail with `409` rather than updating an
ambiguous product.

Media is accepted only as one to six valid JPEG files, each strictly below
300,000 bytes. Content-addressed files are written to the existing
`/data/taha-media` directory through a same-directory temporary file, `fsync`,
and atomic rename. Product responses use the stable public route
`https://tahashoes.vn/product/<ObjectID>` (or `PUBLIC_SITE_URL` when set).

Permission, write, short-write, sync, and close failures stop the temporary file
before rename, so an incomplete image cannot produce a successful receipt.
The staged tests cover those failures and preserve the first I/O error while
still closing the file.

## Controlled installation

`install_receiver.py` defaults to read-only checks. Keep it beside the reviewed
Go files locally, or deploy it as `deploy/vps/website-receiver-install.py` with
the reviewed Go files in `deploy/website-receiver`. Supply diagnosed values using
`--expected-container-id`, `--expected-image-id`, and
`--expected-article-sha256`. Only adding `--apply` permits a local child-image
build, host source updates, and replacement of the backend service.

The installer verifies host/container article equality, the Compose image tag,
unchanged environment and volumes, and a persistent `/data/taha-media` mount.
It uses the running image's `gofmt` on the patched article through stdin/stdout.
The child image must pass formatting, `go test ./handlers`, and `go build` with
networking and Go dependency downloads disabled before live changes begin.
Go, the full backend source, cached modules, and the legacy Docker builder must
already be available in the existing image/daemon.

Both Compose v2 entry points are detected, including standalone
`docker-compose`. Only `backend` is recreated; secrets, the cron timer, Compose
files, and other services are not modified. A local direct GET to the backend's
published `8080/tcp` port must return the public products JSON. Source backups
and a rollback image tag are retained; failed runtime verification restores the
old source and image. The installer never submits product or signed requests.

Run installer guard tests locally with `python3 test_install_receiver.py`.

`rating`, `reviewCount`, and `soldCount` use pointer fields so omission is
distinguishable from an explicit zero. Omitted counters are absent from
`$set`, preserving website-owner values on update; they enter `$setOnInsert` as
zero for a truthful new product. The adapter does not create review records and
does not change `favoriteCount` or `isHidden` on updates.
