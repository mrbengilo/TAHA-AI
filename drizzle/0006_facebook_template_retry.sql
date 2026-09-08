-- A product's SEO title can legitimately include store-policy suffixes such as
-- warranty and gifts. Template v1 copied that full title into the Facebook
-- editorial section, whose structure guard correctly reserves those claims for
-- the verified appendix. Resume the newest affected run per product after v2
-- separates the editorial name from the verified policy appendix.
UPDATE automation_steps
SET status = 'queued', available_at = unixepoch() * 1000, attempt_count = 0, max_attempts = 3,
  lease_owner = NULL, lease_expires_at = NULL,
  result_json = '{"templateRecovery":"facebook-structure-v2"}', error_code = NULL,
  error_message = NULL, started_at = NULL, completed_at = NULL, updated_at = unixepoch() * 1000
WHERE step_type IN ('content', 'finalize')
  AND run_id IN (
    SELECT failed.id
    FROM automation_runs failed
    WHERE (
        (failed.status = 'failed' AND failed.error_code = 'TEMPLATE_FACEBOOK_STRUCTURE_INVALID')
        OR (failed.status IN ('queued', 'processing') AND EXISTS (
          SELECT 1 FROM automation_steps affected
          WHERE affected.run_id = failed.id AND affected.error_code = 'TEMPLATE_FACEBOOK_STRUCTURE_INVALID'
        ))
      )
      AND EXISTS (SELECT 1 FROM json_each(failed.target_providers_json) target WHERE target.value = 'facebook')
      AND EXISTS (SELECT 1 FROM automation_steps content WHERE content.run_id = failed.id AND content.step_type = 'content')
      AND EXISTS (SELECT 1 FROM automation_steps finalize WHERE finalize.run_id = failed.id AND finalize.step_type = 'finalize')
      AND NOT EXISTS (
        SELECT 1 FROM automation_runs newer
        WHERE newer.workspace_id = failed.workspace_id AND newer.product_id = failed.product_id
          AND (newer.created_at > failed.created_at OR (newer.created_at = failed.created_at AND newer.id > failed.id))
      )
      AND NOT EXISTS (
        SELECT 1 FROM automation_runs active
        WHERE active.workspace_id = failed.workspace_id AND active.product_id = failed.product_id
          AND active.id != failed.id AND active.status IN ('queued', 'processing')
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
UPDATE automation_runs
SET status = 'queued', requested_image_count = 0, completed_image_count = 0,
  output_media_ids_json = '[]', text_model = NULL, image_model = NULL,
  content_json = json_set(COALESCE(content_json, '{}'), '$.templateRecovery', 'facebook-structure-v2'),
  prompt_version = 'taha-approved-template-v2', error_code = NULL, error_message = NULL,
  started_at = NULL, completed_at = NULL, updated_at = unixepoch() * 1000
WHERE status IN ('failed', 'queued', 'processing')
  AND EXISTS (
    SELECT 1 FROM automation_steps content
    WHERE content.run_id = automation_runs.id AND content.step_type = 'content' AND content.status = 'queued'
      AND json_extract(content.result_json, '$.templateRecovery') = 'facebook-structure-v2'
  )
  AND EXISTS (SELECT 1 FROM automation_steps finalize WHERE finalize.run_id = automation_runs.id AND finalize.step_type = 'finalize' AND finalize.status = 'queued')
  AND NOT EXISTS (
    SELECT 1 FROM automation_runs active
    WHERE active.workspace_id = automation_runs.workspace_id AND active.product_id = automation_runs.product_id
      AND active.id != automation_runs.id AND active.status IN ('queued', 'processing')
  );
