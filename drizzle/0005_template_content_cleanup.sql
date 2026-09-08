-- Remove failed automation attempts only when every requested channel already
-- has a usable draft for the same product and the failed run owns no output.
DELETE FROM automation_steps
WHERE run_id IN (
  SELECT failed.id
  FROM automation_runs failed
  WHERE failed.status = 'failed'
    AND NOT EXISTS (
      SELECT 1 FROM json_each(failed.target_providers_json) target
      WHERE NOT EXISTS (
        SELECT 1 FROM content_drafts ready
        WHERE ready.workspace_id = failed.workspace_id
          AND ready.product_id = failed.product_id
          AND ready.target_provider = target.value
          AND ready.archived_at IS NULL
          AND ready.body != ''
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM content_drafts own
      WHERE own.workspace_id = failed.workspace_id
        AND json_extract(own.generation_meta_json, '$.automationRunId') = failed.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM schedules own_schedule
      WHERE own_schedule.workspace_id = failed.workspace_id
        AND own_schedule.created_by = 'automation:' || failed.id
    )
);
--> statement-breakpoint
DELETE FROM automation_runs
WHERE status = 'failed'
  AND NOT EXISTS (SELECT 1 FROM automation_steps step WHERE step.run_id = automation_runs.id)
  AND NOT EXISTS (
    SELECT 1 FROM json_each(automation_runs.target_providers_json) target
    WHERE NOT EXISTS (
      SELECT 1 FROM content_drafts ready
      WHERE ready.workspace_id = automation_runs.workspace_id
        AND ready.product_id = automation_runs.product_id
        AND ready.target_provider = target.value
        AND ready.archived_at IS NULL
        AND ready.body != ''
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM content_drafts own
    WHERE own.workspace_id = automation_runs.workspace_id
      AND json_extract(own.generation_meta_json, '$.automationRunId') = automation_runs.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM schedules own_schedule
    WHERE own_schedule.workspace_id = automation_runs.workspace_id
      AND own_schedule.created_by = 'automation:' || automation_runs.id
  );
--> statement-breakpoint
-- Runs that failed solely because the retired OpenAI writer was unavailable
-- are resumed in place, retaining their exact SKU, channels and idempotency key.
DELETE FROM automation_steps
WHERE step_type IN ('image', 'optimize')
  AND run_id IN (
    SELECT failed.id FROM automation_runs failed
    WHERE failed.status = 'failed' AND failed.error_code GLOB 'OPENAI_*'
      AND EXISTS (SELECT 1 FROM automation_steps content WHERE content.run_id = failed.id AND content.step_type = 'content')
      AND EXISTS (SELECT 1 FROM automation_steps finalize WHERE finalize.run_id = failed.id AND finalize.step_type = 'finalize')
      AND NOT EXISTS (
        SELECT 1 FROM automation_runs newer
        WHERE newer.workspace_id = failed.workspace_id AND newer.product_id = failed.product_id
          AND newer.status = 'failed' AND newer.error_code GLOB 'OPENAI_*'
          AND (newer.created_at > failed.created_at OR (newer.created_at = failed.created_at AND newer.id > failed.id))
      )
      AND NOT EXISTS (SELECT 1 FROM content_drafts own WHERE own.workspace_id = failed.workspace_id AND json_extract(own.generation_meta_json, '$.automationRunId') = failed.id)
      AND NOT EXISTS (SELECT 1 FROM schedules own_schedule WHERE own_schedule.workspace_id = failed.workspace_id AND own_schedule.created_by = 'automation:' || failed.id)
      AND NOT EXISTS (SELECT 1 FROM automation_runs active WHERE active.workspace_id = failed.workspace_id AND active.product_id = failed.product_id AND active.status IN ('queued', 'processing'))
  );
--> statement-breakpoint
UPDATE automation_steps
SET status = 'queued', available_at = unixepoch() * 1000, attempt_count = 0, max_attempts = 3,
  lease_owner = NULL, lease_expires_at = NULL, result_json = '{}', error_code = NULL,
  error_message = NULL, started_at = NULL, completed_at = NULL, updated_at = unixepoch() * 1000
WHERE step_type IN ('content', 'finalize')
  AND run_id IN (
    SELECT failed.id FROM automation_runs failed
    WHERE failed.status = 'failed' AND failed.error_code GLOB 'OPENAI_*'
      AND EXISTS (SELECT 1 FROM automation_steps content WHERE content.run_id = failed.id AND content.step_type = 'content')
      AND EXISTS (SELECT 1 FROM automation_steps finalize WHERE finalize.run_id = failed.id AND finalize.step_type = 'finalize')
      AND NOT EXISTS (
        SELECT 1 FROM automation_runs newer
        WHERE newer.workspace_id = failed.workspace_id AND newer.product_id = failed.product_id
          AND newer.status = 'failed' AND newer.error_code GLOB 'OPENAI_*'
          AND (newer.created_at > failed.created_at OR (newer.created_at = failed.created_at AND newer.id > failed.id))
      )
      AND NOT EXISTS (SELECT 1 FROM content_drafts own WHERE own.workspace_id = failed.workspace_id AND json_extract(own.generation_meta_json, '$.automationRunId') = failed.id)
      AND NOT EXISTS (SELECT 1 FROM schedules own_schedule WHERE own_schedule.workspace_id = failed.workspace_id AND own_schedule.created_by = 'automation:' || failed.id)
      AND NOT EXISTS (SELECT 1 FROM automation_runs active WHERE active.workspace_id = failed.workspace_id AND active.product_id = failed.product_id AND active.status IN ('queued', 'processing'))
  );
--> statement-breakpoint
UPDATE automation_runs
SET status = 'queued', requested_image_count = 0, completed_image_count = 0,
  output_media_ids_json = '[]', text_model = NULL, image_model = NULL,
  prompt_version = 'taha-approved-template-v1', error_code = NULL, error_message = NULL,
  started_at = NULL, completed_at = NULL, updated_at = unixepoch() * 1000
WHERE status = 'failed' AND error_code GLOB 'OPENAI_*'
  AND EXISTS (SELECT 1 FROM automation_steps content WHERE content.run_id = automation_runs.id AND content.step_type = 'content' AND content.status = 'queued')
  AND EXISTS (SELECT 1 FROM automation_steps finalize WHERE finalize.run_id = automation_runs.id AND finalize.step_type = 'finalize' AND finalize.status = 'queued')
  AND NOT EXISTS (SELECT 1 FROM content_drafts own WHERE own.workspace_id = automation_runs.workspace_id AND json_extract(own.generation_meta_json, '$.automationRunId') = automation_runs.id)
  AND NOT EXISTS (SELECT 1 FROM schedules own_schedule WHERE own_schedule.workspace_id = automation_runs.workspace_id AND own_schedule.created_by = 'automation:' || automation_runs.id)
  AND NOT EXISTS (SELECT 1 FROM automation_runs active WHERE active.workspace_id = automation_runs.workspace_id AND active.product_id = automation_runs.product_id AND active.status IN ('queued', 'processing'));
