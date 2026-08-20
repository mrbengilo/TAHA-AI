import { hmacHex } from "./integrations/crypto";
import { getConnectedIntegration } from "./integrations/connection-secrets";
import { getRuntimeEnv, requireEnv } from "./integrations/env";
import { TAHA_WORKSPACE_ID } from "./integrations/store";
import { mediaBlob } from "./media";
import { markJobBlocked, markJobFailed, markJobPublished, startPublishJob } from "./publish-jobs";

type FacebookInput = { connectionId: string; message: string; mediaIds: string[]; idempotencyKey: string };
type WebsiteInput = { connectionId: string; payload: Record<string, unknown>; idempotencyKey: string };

export type FacebookRemoteInput = Omit<FacebookInput, "idempotencyKey">;
export type WebsiteRemoteInput = WebsiteInput & { jobId: string };

export class PublishDeliveryError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly outcomeUnknown: boolean;

  constructor(code: string, options: { retryable?: boolean; outcomeUnknown?: boolean } = {}) {
    super(code);
    this.name = "PublishDeliveryError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
  }
}

function database() {
  const value = getRuntimeEnv().DB;
  if (!value) throw new Error("DATABASE_UNAVAILABLE");
  return value;
}

async function facebookJson(url: string | URL, init: RequestInit, phase: "media" | "publish") {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new PublishDeliveryError(
      phase === "publish" ? "FACEBOOK_DELIVERY_OUTCOME_UNKNOWN" : "FACEBOOK_NETWORK_ERROR",
      { retryable: phase === "media", outcomeUnknown: phase === "publish" },
    );
  }

  let data: Record<string, unknown> = {};
  try { data = await response.json() as Record<string, unknown>; } catch { /* no body */ }
  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    throw new PublishDeliveryError(`FACEBOOK_API_${response.status}`, {
      retryable,
      outcomeUnknown: phase === "publish" && response.status >= 500,
    });
  }
  return data;
}

export async function sendFacebookPost(input: FacebookRemoteInput) {
  const connection = await getConnectedIntegration<{ accessToken?: unknown }>("facebook", input.connectionId);
  const pageId = connection.externalAccountId;
  const accessToken = typeof connection.credentials.accessToken === "string" ? connection.credentials.accessToken : "";
  if (!pageId || !accessToken) throw new PublishDeliveryError("FACEBOOK_REAUTH_REQUIRED");

  const version = requireEnv("META_GRAPH_API_VERSION");
  const mediaFbids: string[] = [];
  for (const mediaId of input.mediaIds.slice(0, 10)) {
    const media = await mediaBlob(mediaId);
    const form = new FormData();
    form.set("source", media.blob, media.filename);
    form.set("published", "false");
    form.set("access_token", accessToken);
    const result = await facebookJson(
      `https://graph.facebook.com/${version}/${pageId}/photos`,
      { method: "POST", body: form },
      "media",
    );
    if (typeof result.id === "string") mediaFbids.push(result.id);
  }

  const body = new URLSearchParams({ message: input.message, access_token: accessToken });
  mediaFbids.forEach((id, index) => body.set(`attached_media[${index}]`, JSON.stringify({ media_fbid: id })));
  const result = await facebookJson(
    `https://graph.facebook.com/${version}/${pageId}/feed`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    },
    "publish",
  );
  const postId = typeof result.id === "string" ? result.id : "";
  if (!postId) throw new PublishDeliveryError("FACEBOOK_POST_ID_MISSING", { outcomeUnknown: true });
  return {
    externalId: postId,
    externalUrl: `https://www.facebook.com/${postId}`,
    providerResponse: { mediaCount: mediaFbids.length },
  };
}

export async function recordFacebookMapping(input: {
  connectionId: string;
  jobId: string;
  externalId: string;
  externalUrl: string;
}) {
  const now = Date.now();
  try {
    await database().prepare(
      `INSERT INTO channel_mappings (id, workspace_id, connection_id, entity_type, entity_id, external_id,
       external_url, sync_status, last_synced_at, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, 'post', ?, ?, ?, 'synced', ?, '{}', ?, ?)
       ON CONFLICT(connection_id, entity_type, entity_id) DO UPDATE SET external_id = excluded.external_id,
       external_url = excluded.external_url, last_synced_at = excluded.last_synced_at, updated_at = excluded.updated_at`,
    ).bind(
      crypto.randomUUID(),
      TAHA_WORKSPACE_ID,
      input.connectionId,
      input.jobId,
      input.externalId,
      input.externalUrl,
      now,
      now,
      now,
    ).run();
    return true;
  } catch {
    return false;
  }
}

export async function sendWebsitePayload(input: WebsiteRemoteInput) {
  const connection = await getConnectedIntegration<{ webhookSecret?: unknown }>("website", input.connectionId);
  const secret = typeof connection.credentials.webhookSecret === "string" ? connection.credentials.webhookSecret : "";
  const endpoint = typeof connection.config.publishEndpoint === "string" ? connection.config.publishEndpoint : "";
  if (!secret || !endpoint) throw new PublishDeliveryError("WEBSITE_REAUTH_REQUIRED");

  const body = JSON.stringify({ ...input.payload, tahaJobId: input.jobId });
  const signature = await hmacHex(secret, body);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-taha-signature": `sha256=${signature}`,
        "x-taha-idempotency-key": input.idempotencyKey,
      },
      body,
    });
  } catch {
    throw new PublishDeliveryError("WEBSITE_NETWORK_ERROR", { retryable: true });
  }
  if (!response.ok) {
    throw new PublishDeliveryError(`WEBSITE_API_${response.status}`, {
      retryable: response.status === 429 || response.status >= 500,
    });
  }
  const result = await response.json().catch(() => ({})) as Record<string, unknown>;
  return {
    externalId: typeof result.id === "string" ? result.id : input.jobId,
    externalUrl: typeof result.url === "string" ? result.url : null,
    providerResponse: { accepted: true },
  };
}

export async function publishFacebook(input: FacebookInput) {
  const job = await startPublishJob({
    connectionId: input.connectionId,
    dedupeKey: input.idempotencyKey,
    jobKind: "social_post",
    payload: { message: input.message, mediaIds: input.mediaIds },
  });
  if (job.replay) {
    if (job.status === "published") return { jobId: job.id, postId: job.external_post_id, url: job.external_url, replay: true };
    throw new Error("IDEMPOTENCY_KEY_IN_USE");
  }

  let accepted: Awaited<ReturnType<typeof sendFacebookPost>> | null = null;
  try {
    accepted = await sendFacebookPost(input);
    await markJobPublished(job.id, accepted.externalId, accepted.externalUrl, accepted.providerResponse);
    await recordFacebookMapping({
      connectionId: input.connectionId,
      jobId: job.id,
      externalId: accepted.externalId,
      externalUrl: accepted.externalUrl,
    });
    return { jobId: job.id, postId: accepted.externalId, url: accepted.externalUrl, replay: false };
  } catch (error) {
    if (accepted || (error instanceof PublishDeliveryError && error.outcomeUnknown)) {
      await markJobBlocked(
        job.id,
        error instanceof Error ? error.message : "FACEBOOK_DELIVERY_OUTCOME_UNKNOWN",
        "Facebook có thể đã nhận bài; cần đối soát trước khi thử lại.",
      );
    } else {
      await markJobFailed(job.id, error instanceof Error ? error.message : "FACEBOOK_PUBLISH_FAILED", "Facebook chưa nhận được bài đăng.");
    }
    throw error;
  }
}

export async function publishWebsite(input: WebsiteInput) {
  const job = await startPublishJob({
    connectionId: input.connectionId,
    dedupeKey: input.idempotencyKey,
    jobKind: "social_post",
    payload: input.payload,
  });
  if (job.replay) {
    if (job.status === "published") return { jobId: job.id, externalId: job.external_post_id, url: job.external_url, replay: true };
    throw new Error("IDEMPOTENCY_KEY_IN_USE");
  }
  try {
    const accepted = await sendWebsitePayload({ ...input, jobId: job.id });
    await markJobPublished(job.id, accepted.externalId, accepted.externalUrl, accepted.providerResponse);
    return { jobId: job.id, externalId: accepted.externalId, url: accepted.externalUrl, replay: false };
  } catch (error) {
    await markJobFailed(job.id, error instanceof Error ? error.message : "WEBSITE_PUBLISH_FAILED", "Website chưa nhận được nội dung.");
    throw error;
  }
}
