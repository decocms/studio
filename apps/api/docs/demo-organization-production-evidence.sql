-- E1-E7: read-only evidence for demo-organization-proposal.md.
-- Production SELECTs were run through the read-only MCP. This psql wrapper
-- adds one consistent transaction when direct libpq access is available.
-- Use environment-based connection configuration; never put credentials here.
-- psql -X -v ON_ERROR_STOP=1 -v org_slug=demo-storefront \
--   -v window_start='2026-09-11T17:38:52Z' \
--   -v window_end='2026-09-18T17:38:52Z' \
--   -f apps/api/docs/demo-organization-production-evidence.sql
-- Results reflect retained data at query time. E1/E2/E7 describe CURRENT
-- state, not historical state at window_end. No time-travel claim is made.
-- No prompts, messages, actor IDs, repository names or raw tool errors emitted.
\set ON_ERROR_STOP on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '2s';
SET LOCAL TIME ZONE 'UTC';

SELECT now() AS observed_at,
       :'window_start'::timestamptz AS window_start_inclusive,
       :'window_end'::timestamptz AS window_end_exclusive,
       current_setting('transaction_read_only') AS read_only
WHERE EXISTS (SELECT 1 FROM organization WHERE slug = :'org_slug');

-- E1: current state, including dismissed cards and old nonterminal threads.
SELECT i.status, (i.dismissed_at IS NOT NULL) AS dismissed, count(*) AS cards
FROM task_board_items i
JOIN organization o ON o.id = i.organization_id
WHERE o.slug = :'org_slug'
GROUP BY i.status, (i.dismissed_at IS NOT NULL)
ORDER BY i.status, dismissed;

SELECT t.status, count(*) AS threads,
       min(t.updated_at::timestamptz) AS oldest_last_update,
       max(t.updated_at::timestamptz) AS newest_last_update
FROM threads t
JOIN organization o ON o.id = t.organization_id
WHERE o.slug = :'org_slug'
GROUP BY t.status
ORDER BY t.status;

-- E2: references in active maintenance prompts versus retained card IDs.
-- This is a diagnostic for the current prompt format, NOT a reset algorithm.
-- Repeated IDs in message text/editor metadata are deduplicated. If multiple
-- automations are active, the result is their union; inspect E7 before calling
-- this union a single baseline. A future manifest must use schema validation.
WITH target AS (
  SELECT id FROM organization WHERE slug = :'org_slug'
), refs AS (
  SELECT DISTINCT m[1] AS task_id
  FROM automations a
  JOIN target o ON o.id = a.organization_id
  CROSS JOIN LATERAL regexp_matches(a.messages, 'board_[A-Za-z0-9_-]+', 'g') m
  WHERE a.active
)
SELECT count(*) AS referenced_card_ids,
       count(*) FILTER (WHERE i.id IS NULL) AS missing_cards,
       count(*) FILTER (WHERE i.dismissed_at IS NOT NULL) AS dismissed_cards,
       (
         SELECT count(*) FROM task_board_items x
         JOIN target o ON o.id = x.organization_id
         WHERE x.dismissed_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM refs r WHERE r.task_id = x.id)
       ) AS extra_undismissed_cards
FROM refs
LEFT JOIN task_board_items i
  ON i.id = refs.task_id AND i.organization_id = (SELECT id FROM target);

-- E3: executor workflow duration, NOT thread updated_at or part created_at.
-- Requires the DBOS schema and the current hosted workflow ID convention.
-- Includes all workflow statuses; inspect n/measured before interpreting the
-- min/max. Gate/projector rows are excluded rather than counted as runs.
-- "automation" is not inherently a reset; E7 identifies the actual purpose.
-- Workflow SUCCESS says the executor ended, not that tools or the demo passed.
SELECT CASE
         WHEN t.trigger_id IS NOT NULL THEN 'automation'
         WHEN t.title LIKE 'Reviewer:%' THEN 'reviewer'
         ELSE 'task_execution'
       END AS category,
       w.status, count(*) AS workflows,
       count(*) FILTER (
         WHERE w.started_at_epoch_ms IS NOT NULL AND w.completed_at IS NOT NULL
       ) AS measured,
       min(w.started_at_epoch_ms - w.created_at) AS min_queue_ms,
       max(w.started_at_epoch_ms - w.created_at) AS max_queue_ms,
       min(w.completed_at - w.started_at_epoch_ms) AS min_runtime_ms,
       max(w.completed_at - w.started_at_epoch_ms) AS max_runtime_ms
FROM dbos.workflow_status w
JOIN threads t ON split_part(w.workflow_uuid, ':', 2) = t.id
JOIN organization o ON o.id = t.organization_id
WHERE o.slug = :'org_slug'
  AND w.name = 'hostedHarnessWorkflow'
  AND starts_with(w.workflow_uuid, 'decopilot-hosted:')
  AND w.created_at >= extract(epoch FROM :'window_start'::timestamptz) * 1000
  AND w.created_at < extract(epoch FROM :'window_end'::timestamptz) * 1000
GROUP BY category, w.status
ORDER BY category, w.status;

-- E4: tool errors persisted in the window, in threads with an E3 workflow.
-- EXISTS avoids duplicating parts when a thread has multiple workflows.
-- Counts threads/parts, not failed runs; persisted_at is not event time.
-- No raw errors emitted.
SELECT CASE
         WHEN t.trigger_id IS NOT NULL THEN 'automation'
         WHEN t.title LIKE 'Reviewer:%' THEN 'reviewer'
         ELSE 'task_execution'
       END AS category,
       count(*) AS output_error_parts,
       count(DISTINCT t.id) AS affected_threads
FROM thread_message_parts p
JOIN threads t ON t.id = p.thread_id AND t.organization_id = p.org_id
JOIN organization o ON o.id = t.organization_id
WHERE o.slug = :'org_slug'
  AND p.persisted_at >= :'window_start'::timestamptz
  AND p.persisted_at < :'window_end'::timestamptz
  AND EXISTS (
    SELECT 1 FROM dbos.workflow_status w
    WHERE split_part(w.workflow_uuid, ':', 2) = t.id
      AND w.name = 'hostedHarnessWorkflow'
      AND starts_with(w.workflow_uuid, 'decopilot-hosted:')
      AND w.created_at >= extract(epoch FROM :'window_start'::timestamptz) * 1000
      AND w.created_at < extract(epoch FROM :'window_end'::timestamptz) * 1000
  )
  AND p.kind = 'tool_result'
  AND p.payload->>'state' = 'output-error'
GROUP BY category
ORDER BY category;

-- E5: new cards by stored origin. Non-system/non-automation is a candidate
-- manual card; inspect its creation activity privately before asserting that.
SELECT i.created_by = 'system' AS reports,
       i.title LIKE 'Automation:%' AS automation_title,
       count(*) AS cards
FROM task_board_items i
JOIN organization o ON o.id = i.organization_id
WHERE o.slug = :'org_slug'
  AND i.created_at >= :'window_start'::timestamptz
  AND i.created_at < :'window_end'::timestamptz
GROUP BY i.created_by = 'system', i.title LIKE 'Automation:%';

-- E6: retained activity, not clicks, sales sessions or a complete audit trail.
SELECT count(*) AS activity_events,
       count(DISTINCT a.task_board_item_id) AS cards_with_activity,
       count(DISTINCT a.actor_id) AS distinct_actor_ids
FROM task_board_activity a
JOIN task_board_items i ON i.id = a.task_board_item_id
JOIN organization o ON o.id = i.organization_id
WHERE o.slug = :'org_slug'
  AND a.occurred_at >= :'window_start'::timestamptz
  AND a.occurred_at < :'window_end'::timestamptz;

-- E7: current scheduler configuration. Deliberately excludes messages/models,
-- names, credentials and trigger params. The prompt and final assistant text
-- were separately inspected in private, never copied into this repository.
SELECT a.active, a.created_at, tr.type, tr.cron_expression,
       tr.last_run_at, tr.next_run_at
FROM automations a
JOIN organization o ON o.id = a.organization_id
LEFT JOIN automation_triggers tr ON tr.automation_id = a.id
WHERE o.slug = :'org_slug'
ORDER BY a.created_at, tr.type;

ROLLBACK;
