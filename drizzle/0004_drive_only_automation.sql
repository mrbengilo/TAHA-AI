-- Retain history and original files. Old image workflows require a fresh confirmation.
UPDATE automation_runs SET status = 'cancelled', error_code = 'DRIVE_ONLY_RESTART_REQUIRED',
  error_message = 'Đã chuyển sang ảnh Drive. Xác nhận lại để tự viết bài và lên lịch.',
  completed_at = unixepoch() * 1000, updated_at = unixepoch() * 1000
WHERE status IN ('queued', 'processing') AND requested_image_count > 0;
--> statement-breakpoint
UPDATE automation_steps SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL
WHERE status IN ('queued', 'processing', 'retry_wait') AND run_id IN (
  SELECT id FROM automation_runs WHERE error_code = 'DRIVE_ONLY_RESTART_REQUIRED');
--> statement-breakpoint
UPDATE schedules SET status = 'paused', next_run_at = NULL
WHERE status = 'active' AND draft_id IN (
  SELECT dm.draft_id FROM content_draft_media dm JOIN media_assets m ON m.id = dm.media_id
  WHERE m.origin IN ('generated', 'derived'));
--> statement-breakpoint
UPDATE publish_jobs SET status = 'cancelled', error_code = 'DRIVE_ONLY_RESTART_REQUIRED'
WHERE status IN ('queued', 'retry_wait', 'awaiting_confirmation') AND draft_id IN (
  SELECT dm.draft_id FROM content_draft_media dm JOIN media_assets m ON m.id = dm.media_id
  WHERE m.origin IN ('generated', 'derived'));
