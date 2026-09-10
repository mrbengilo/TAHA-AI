import {
  APPROVED_TEMPLATE_MODEL,
  CANONICAL_ARTICLE_VERSION,
  generateProductContentWithTemplate,
} from "./ai/template";
import {
  POST_TEMPLATE_ID,
  POST_TEMPLATE_KEY,
  PostTemplateError,
  changes,
  fingerprintPostTemplate,
  getPostTemplate,
  normalizePostTemplateConfig,
  previewPostTemplate,
  requirePostTemplateDatabase,
  type PostTemplateConfig,
  type PostTemplateDatabase,
  type PostTemplateRefreshResult,
  type PostTemplateSnapshot,
} from "./post-template";
import { ensureWorkspace, TAHA_WORKSPACE_ID } from "./integrations/store";

export type UpdatePostTemplateInput = {
  expectedVersion?: unknown;
  config?: unknown;
};

type ArticleProductRow = {
  article_id: string;
  product_id: string;
  source_fingerprint: string;
  base_sku: string;
  name: string;
  description: string;
  brand: string | null;
  category: string | null;
  currency: string;
  metadata_json: string;
  price_minor: number | null;
  compare_at_price_minor: number | null;
  inventory_quantity: number | null;
};

type PreparedArticle = {
  productId: string;
  title: string;
  body: string;
  hashtagsJson: string;
  sourceCorrectionsJson: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function jsonRecord(value: string) {
  try {
    return record(JSON.parse(value));
  } catch {
    return {};
  }
}

function list(value: unknown, maxItems: number, maxLength: number) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => typeof item === "string" ? item.trim().slice(0, maxLength) : "")
    .filter(Boolean))].slice(0, maxItems);
}

function requiredExpectedVersion(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new PostTemplateError("POST_TEMPLATE_VERSION_REQUIRED", "Phiên bản bài viết mẫu không hợp lệ.");
  }
  return Number(value);
}

function canonicalArticle(value: unknown) {
  const item = record(value);
  const version = typeof item.version === "string" ? item.version : "";
  const title = typeof item.title === "string" ? item.title.trim() : "";
  const body = typeof item.body === "string" ? item.body.trim() : "";
  const hashtags = Array.isArray(item.hashtags)
    ? item.hashtags.filter((tag): tag is string => typeof tag === "string")
    : [];
  if (!title || !body || version !== CANONICAL_ARTICLE_VERSION) {
    throw new PostTemplateError(
      "POST_TEMPLATE_RENDER_INVALID",
      "Bài viết mẫu không thể tạo nội dung hợp lệ cho một hoặc nhiều sản phẩm.",
      409,
    );
  }
  return { title, body, hashtags };
}

async function loadArticleProducts(db: PostTemplateDatabase) {
  const rows = await db.prepare(
    `SELECT a.id AS article_id,a.product_id,a.source_fingerprint,
            p.base_sku,p.name,p.description,p.brand,p.category,p.currency,p.metadata_json,
            (SELECT MIN(v.price_minor) FROM product_variants v
             WHERE v.workspace_id=p.workspace_id AND v.product_id=p.id AND v.status='active') AS price_minor,
            (SELECT MAX(v.compare_at_price_minor) FROM product_variants v
             WHERE v.workspace_id=p.workspace_id AND v.product_id=p.id AND v.status='active') AS compare_at_price_minor,
            (SELECT SUM(v.inventory_quantity) FROM product_variants v
             WHERE v.workspace_id=p.workspace_id AND v.product_id=p.id AND v.status='active') AS inventory_quantity
     FROM product_articles a
     JOIN products p ON p.id=a.product_id AND p.workspace_id=a.workspace_id
     WHERE a.workspace_id=? AND p.deleted_at IS NULL
     ORDER BY a.product_id`,
  ).bind(TAHA_WORKSPACE_ID).all<ArticleProductRow>();
  return rows.results ?? [];
}

async function prepareArticles(
  db: PostTemplateDatabase,
  template: PostTemplateSnapshot,
): Promise<PreparedArticle[]> {
  const rows = await loadArticleProducts(db);
  const prepared: PreparedArticle[] = [];
  for (const row of rows) {
    const metadata = jsonRecord(row.metadata_json);
    const website = record(metadata.website);
    const generated = await generateProductContentWithTemplate({
      product: {
        sku: row.base_sku,
        name: row.name,
        description: row.description,
        brand: row.brand ?? undefined,
        category: row.category ?? undefined,
        currency: row.currency,
        priceMinor: row.price_minor ?? undefined,
        compareAtPriceMinor: row.compare_at_price_minor ?? undefined,
        inventoryQuantity: row.inventory_quantity ?? undefined,
        sizes: list(website.sizes, 30, 40),
        colors: list(website.colors, 30, 160),
        gifts: list(website.gifts, 20, 160),
        specifications: list(website.specifications, 80, 160),
      },
      targetProviders: ["facebook"],
    }, template);
    const generatedContent = record(generated.content);
    const article = canonicalArticle(generatedContent.canonicalArticle);
    const sourceCorrections = Array.isArray(generatedContent.sourceCorrections)
      ? generatedContent.sourceCorrections.filter((item): item is string => typeof item === "string")
      : [];
    prepared.push({
      productId: row.product_id,
      title: article.title,
      body: article.body,
      hashtagsJson: JSON.stringify(article.hashtags),
      sourceCorrectionsJson: JSON.stringify(sourceCorrections),
    });
  }
  return prepared;
}

async function currentPublishingCount(db: PostTemplateDatabase) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS total
     FROM publish_jobs j
     JOIN content_drafts d ON d.id=j.draft_id AND d.workspace_id=j.workspace_id
     WHERE j.workspace_id=? AND j.status='publishing' AND d.generator='template'`,
  ).bind(TAHA_WORKSPACE_ID).first<{ total: number }>();
  return Number(row?.total ?? 0);
}

async function staleBlockedCount(db: PostTemplateDatabase) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS total
     FROM publish_jobs j
     JOIN content_drafts d ON d.id=j.draft_id AND d.workspace_id=j.workspace_id
     WHERE j.workspace_id=? AND j.status='blocked' AND j.error_code='PRODUCT_CONTENT_STALE'
       AND j.external_post_id IS NULL AND d.generator='template'`,
  ).bind(TAHA_WORKSPACE_ID).first<{ total: number }>();
  return Number(row?.total ?? 0);
}

function activeContentGuard() {
  return `NOT EXISTS (
    SELECT 1 FROM automation_steps s
    JOIN automation_runs r ON r.id=s.run_id AND r.workspace_id=s.workspace_id
    WHERE s.workspace_id=? AND s.step_type='content' AND s.status='processing'
      AND s.lease_expires_at IS NOT NULL AND s.lease_expires_at>?
      AND r.status IN ('queued','processing')
  )`;
}

function templateExistsGuard() {
  return `EXISTS (
    SELECT 1 FROM post_templates t
    WHERE t.id=? AND t.workspace_id=? AND t.template_key=? AND t.version=? AND t.fingerprint=? AND t.revision_token=?
  )`;
}

function templateWriteStatement(
  db: PostTemplateDatabase,
  current: PostTemplateSnapshot,
  next: PostTemplateSnapshot,
  actorId: string,
  revisionToken: string,
  now: number,
) {
  const configJson = JSON.stringify(next.config);
  if (current.isDefault) {
    return db.prepare(
      `INSERT INTO post_templates
       (id,workspace_id,template_key,name,version,fingerprint,config_json,updated_by,revision_token,created_at,updated_at)
       SELECT ?,?,?,?,?,?,?,?,?,?,?
       WHERE ${activeContentGuard()}
       ON CONFLICT(workspace_id,template_key) DO NOTHING`,
    ).bind(
      POST_TEMPLATE_ID,
      TAHA_WORKSPACE_ID,
      POST_TEMPLATE_KEY,
      next.config.name,
      next.version,
      next.fingerprint,
      configJson,
      actorId,
      revisionToken,
      now,
      now,
      TAHA_WORKSPACE_ID,
      now,
    );
  }
  return db.prepare(
    `UPDATE post_templates
     SET name=?,version=?,fingerprint=?,config_json=?,updated_by=?,revision_token=?,updated_at=?
     WHERE id=? AND workspace_id=? AND template_key=? AND version=?
       AND ${activeContentGuard()}`,
  ).bind(
    next.config.name,
    next.version,
    next.fingerprint,
    configJson,
    actorId,
    revisionToken,
    now,
    POST_TEMPLATE_ID,
    TAHA_WORKSPACE_ID,
    POST_TEMPLATE_KEY,
    current.version,
    TAHA_WORKSPACE_ID,
    now,
  );
}

/**
 * Persists one new template revision and refreshes every unpublished,
 * template-generated article snapshot in the same SQLite transaction.
 * Published or currently publishing deliveries are deliberately immutable.
 */
export async function updatePostTemplate(
  input: UpdatePostTemplateInput,
  actorId: string,
  override?: PostTemplateDatabase,
) {
  const db = requirePostTemplateDatabase(override);
  await ensureWorkspace();
  const expectedVersion = requiredExpectedVersion(input.expectedVersion);
  const current = await getPostTemplate(db);
  if (current.version !== expectedVersion) {
    throw new PostTemplateError(
      "POST_TEMPLATE_VERSION_CONFLICT",
      "Bài viết mẫu vừa được cập nhật ở phiên khác. Hãy tải lại trước khi lưu.",
      409,
      { currentVersion: current.version },
    );
  }
  const config = normalizePostTemplateConfig(input.config);
  const fingerprint = await fingerprintPostTemplate(config);
  if (fingerprint === current.fingerprint) {
    return {
      template: current,
      preview: previewPostTemplate(current.config),
      changed: false,
      refresh: {
        articles: 0,
        drafts: 0,
        jobs: 0,
        staleJobsRequeued: 0,
        publishingJobsSkipped: await currentPublishingCount(db),
      } satisfies PostTemplateRefreshResult,
    };
  }

  const now = Date.now();
  const revisionToken = crypto.randomUUID();
  const safeActor = actorId.trim().slice(0, 160) || "operator";
  const next: PostTemplateSnapshot = {
    id: POST_TEMPLATE_ID,
    key: POST_TEMPLATE_KEY,
    version: current.version + 1,
    fingerprint,
    config,
    updatedBy: safeActor,
    createdAt: current.createdAt ?? now,
    updatedAt: now,
    isDefault: false,
  };
  const prepared = await prepareArticles(db, next);
  const preparedJson = JSON.stringify(prepared);
  if (preparedJson.length > 12_000_000) {
    throw new PostTemplateError(
      "POST_TEMPLATE_REFRESH_TOO_LARGE",
      "Khối lượng bài viết cần cập nhật quá lớn để xử lý an toàn trong một lần lưu.",
      409,
    );
  }
  const publishingJobsSkipped = await currentPublishingCount(db);
  const staleJobsRequeued = await staleBlockedCount(db);
  const guardValues = [POST_TEMPLATE_ID, TAHA_WORKSPACE_ID, POST_TEMPLATE_KEY, next.version, next.fingerprint, revisionToken] as const;

  const statements = [
    templateWriteStatement(db, current, next, safeActor, revisionToken, now),
    db.prepare(
      `WITH prepared(product_id,title,body,hashtags_json,source_corrections_json) AS (
         SELECT json_extract(value,'$.productId'),
                json_extract(value,'$.title'),
                json_extract(value,'$.body'),
                json_extract(value,'$.hashtagsJson'),
                json_extract(value,'$.sourceCorrectionsJson')
         FROM json_each(?)
       )
       UPDATE product_articles
       SET title=(SELECT title FROM prepared WHERE product_id=product_articles.product_id),
           body=(SELECT body FROM prepared WHERE product_id=product_articles.product_id),
           hashtags_json=(SELECT hashtags_json FROM prepared WHERE product_id=product_articles.product_id),
           source_corrections_json=(SELECT source_corrections_json FROM prepared WHERE product_id=product_articles.product_id),
           model=?,prompt_version=?,updated_at=?
       WHERE workspace_id=?
         AND EXISTS (SELECT 1 FROM prepared WHERE product_id=product_articles.product_id)
         AND ${templateExistsGuard()}`,
    ).bind(
      preparedJson,
      APPROVED_TEMPLATE_MODEL,
      APPROVED_TEMPLATE_MODEL,
      now,
      TAHA_WORKSPACE_ID,
      ...guardValues,
    ),
    db.prepare(
      `UPDATE content_drafts
       SET title=(SELECT a.title FROM product_articles a
                  WHERE a.workspace_id=content_drafts.workspace_id AND a.product_id=content_drafts.product_id),
           body=(SELECT a.body FROM product_articles a
                 WHERE a.workspace_id=content_drafts.workspace_id AND a.product_id=content_drafts.product_id),
           hashtags_json=(SELECT a.hashtags_json FROM product_articles a
                          WHERE a.workspace_id=content_drafts.workspace_id AND a.product_id=content_drafts.product_id),
           platform_data_json=json_set(
             CASE WHEN json_valid(platform_data_json) THEN platform_data_json ELSE '{}' END,
             '$.postTemplateVersion',?,
             '$.postTemplateFingerprint',?,
             '$.contentTemplateVersion',?
           ),
           generation_meta_json=json_set(
             CASE WHEN json_valid(generation_meta_json) THEN generation_meta_json ELSE '{}' END,
             '$.postTemplateVersion',?,
             '$.postTemplateFingerprint',?
           ),
           model=?,prompt_version=?,version=version+1,updated_at=?
       WHERE workspace_id=? AND generator='template' AND status IN ('draft','in_review','approved')
         AND EXISTS (
           SELECT 1 FROM product_articles a
           WHERE a.workspace_id=content_drafts.workspace_id AND a.product_id=content_drafts.product_id
         )
         AND ${templateExistsGuard()}`,
    ).bind(
      next.version,
      next.fingerprint,
      APPROVED_TEMPLATE_MODEL,
      next.version,
      next.fingerprint,
      APPROVED_TEMPLATE_MODEL,
      APPROVED_TEMPLATE_MODEL,
      now,
      TAHA_WORKSPACE_ID,
      ...guardValues,
    ),
    db.prepare(
      `UPDATE publish_jobs
       SET payload_snapshot_json=json_set(
             CASE WHEN json_valid(payload_snapshot_json) THEN payload_snapshot_json ELSE '{}' END,
             '$.title',COALESCE((SELECT d.title FROM content_drafts d
                                WHERE d.id=publish_jobs.draft_id AND d.workspace_id=publish_jobs.workspace_id),''),
             '$.message',(SELECT d.body FROM content_drafts d
                          WHERE d.id=publish_jobs.draft_id AND d.workspace_id=publish_jobs.workspace_id),
             '$.hashtags',json((SELECT d.hashtags_json FROM content_drafts d
                                WHERE d.id=publish_jobs.draft_id AND d.workspace_id=publish_jobs.workspace_id)),
             '$.draftVersion',(SELECT d.version FROM content_drafts d
                               WHERE d.id=publish_jobs.draft_id AND d.workspace_id=publish_jobs.workspace_id),
             '$.platformData',json((SELECT d.platform_data_json FROM content_drafts d
                                    WHERE d.id=publish_jobs.draft_id AND d.workspace_id=publish_jobs.workspace_id))
           ),
           status=CASE
             WHEN status='blocked' AND error_code='PRODUCT_CONTENT_STALE' AND external_post_id IS NULL THEN 'queued'
             ELSE status
           END,
           available_at=CASE
             WHEN status='blocked' AND error_code='PRODUCT_CONTENT_STALE' AND external_post_id IS NULL THEN ?
             ELSE available_at
           END,
           error_code=CASE
             WHEN status='blocked' AND error_code='PRODUCT_CONTENT_STALE' AND external_post_id IS NULL THEN NULL
             ELSE error_code
           END,
           error_message=CASE
             WHEN status='blocked' AND error_code='PRODUCT_CONTENT_STALE' AND external_post_id IS NULL THEN NULL
             ELSE error_message
           END,
           updated_at=?
       WHERE workspace_id=? AND external_post_id IS NULL
         AND status IN ('queued','retry_wait','blocked','awaiting_confirmation','failed')
         AND EXISTS (
           SELECT 1 FROM content_drafts d
           WHERE d.id=publish_jobs.draft_id AND d.workspace_id=publish_jobs.workspace_id
             AND d.generator='template'
         )
         AND ${templateExistsGuard()}`,
    ).bind(now, now, TAHA_WORKSPACE_ID, ...guardValues),
    db.prepare(
      `INSERT INTO audit_logs
       (id,workspace_id,actor_type,actor_id,actor_label,action,entity_type,entity_id,before_json,after_json,metadata_json,created_at)
       SELECT ?,?,'user',?,?,'POST_TEMPLATE_UPDATED','post_template',?,?,?,?,?
       WHERE ${templateExistsGuard()}`,
    ).bind(
      crypto.randomUUID(),
      TAHA_WORKSPACE_ID,
      safeActor,
      safeActor,
      POST_TEMPLATE_ID,
      JSON.stringify({ version: current.version, fingerprint: current.fingerprint, config: current.config }),
      JSON.stringify({ version: next.version, fingerprint: next.fingerprint, config: next.config }),
      JSON.stringify({ refreshedArticleCount: prepared.length, publishingJobsSkipped }),
      now,
      ...guardValues,
    ),
  ];

  const results = await db.batch(statements);
  if (changes(results[0]) === 0) {
    const latest = await getPostTemplate(db);
    if (latest.version !== current.version) {
      throw new PostTemplateError(
        "POST_TEMPLATE_VERSION_CONFLICT",
        "Bài viết mẫu vừa được cập nhật ở phiên khác. Hãy tải lại trước khi lưu.",
        409,
        { currentVersion: latest.version },
      );
    }
    throw new PostTemplateError(
      "POST_TEMPLATE_CONTENT_BUSY",
      "Hệ thống đang hoàn tất một bài viết. Hãy lưu lại sau ít phút để tránh trộn hai cấu trúc.",
      409,
    );
  }
  if (changes(results[4]) === 0) {
    throw new PostTemplateError(
      "POST_TEMPLATE_AUDIT_FAILED",
      "Bài viết mẫu đã không được lưu vì không thể ghi nhật ký thay đổi.",
      500,
    );
  }

  return {
    template: next,
    preview: previewPostTemplate(next.config),
    changed: true,
    refresh: {
      articles: changes(results[1]),
      drafts: changes(results[2]),
      jobs: changes(results[3]),
      staleJobsRequeued,
      publishingJobsSkipped,
    } satisfies PostTemplateRefreshResult,
  };
}
