-- Read-only research companion to demo-organization-proposal.md.
-- Validated on local PostgreSQL with real migrations; equivalent SELECTs were
-- used through the read-only production MCP during the follow-up research.
-- See demo-organization-production-evidence.sql for the fixed-window cohort.
-- Use libpq environment configuration (PGHOST/PGDATABASE/etc.); do not paste
-- credentials into the command or commit query results to this public repo.
-- psql -X -v ON_ERROR_STOP=1 -v org_slug=demo-storefront -v days=7 \
--   -f apps/api/docs/demo-organization-audit.sql
-- A missing slug fails at the first query; a nonexistent slug yields no data.
\set ON_ERROR_STOP on
\if :{?days}
\else
  \set days 7
\endif

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '2s';
SET LOCAL TIME ZONE 'UTC';

-- Record the actual observation time and bound the window to 1..30 days.
SELECT now() AS observed_at,
       now() - make_interval(days => greatest(1, least(30, :'days'::integer))) AS window_start,
       id AS organization_id, slug
FROM organization
WHERE slug = :'org_slug';

-- All current cards, including archived/dismissed, not only newly created ones.
SELECT i.status,
       (i.dismissed_at IS NOT NULL) AS dismissed,
       count(*) AS cards,
       count(*) FILTER (WHERE i.retry_at IS NOT NULL) AS waiting_for_retry,
       count(*) FILTER (WHERE i.due_date < now()) AS past_due_date,
       min(i.created_at) AS oldest_created_at,
       max(i.updated_at) AS latest_updated_at
FROM task_board_items i
JOIN organization o ON o.id = i.organization_id
WHERE o.slug = :'org_slug'
GROUP BY i.status, (i.dismissed_at IS NOT NULL)
ORDER BY i.status, dismissed;

-- Activity on old cards is included. No actor identity or free-text payloads.
SELECT date_trunc('day', a.occurred_at) AS day_utc,
       a.action, count(*) AS events,
       count(DISTINCT a.task_board_item_id) AS distinct_tasks,
       count(DISTINCT a.actor_id) AS distinct_human_actor_ids
FROM task_board_activity a
JOIN task_board_items i ON i.id = a.task_board_item_id
JOIN organization o ON o.id = i.organization_id
WHERE o.slug = :'org_slug'
  AND a.occurred_at >= now() - make_interval(days => greatest(1, least(30, :'days'::integer)))
GROUP BY day_utc, a.action
ORDER BY day_utc, a.action;

-- Bounded, private inspection of cards touched recently. Do not publish titles.
SELECT i.id, i.title, i.status, i.priority, i.assignee_id,
       i.created_at, i.updated_at, i.due_date, i.retry_at, i.retry_attempts,
       i.dismissed_at, i.review_cycle_started_at
FROM task_board_items i
JOIN organization o ON o.id = i.organization_id
WHERE o.slug = :'org_slug'
  AND (
    i.created_at >= now() - make_interval(days => greatest(1, least(30, :'days'::integer)))
    OR i.updated_at >= now() - make_interval(days => greatest(1, least(30, :'days'::integer)))
    OR EXISTS (
      SELECT 1 FROM task_board_activity a
      WHERE a.task_board_item_id = i.id
        AND a.occurred_at >= now() - make_interval(days => greatest(1, least(30, :'days'::integer)))
    )
  )
ORDER BY i.updated_at DESC
LIMIT 200;

-- Current thread state is NOT a historical run outcome count. Include active
-- threads even when their latest update predates the research window.
SELECT t.id AS thread_id, t.status, t.harness_id, t.created_at, t.updated_at,
       t.run_started_at, t.last_progress_at, t.failure_kind,
       t.cancel_requested_at,
       ARRAY(
         SELECT l.task_board_item_id
         FROM task_board_item_threads l
         JOIN task_board_items i ON i.id = l.task_board_item_id
         WHERE l.thread_id = t.id
           AND l.organization_id = t.organization_id
           AND i.organization_id = t.organization_id
         ORDER BY l.task_board_item_id
       ) AS task_ids
FROM threads t
JOIN organization o ON o.id = t.organization_id
WHERE o.slug = :'org_slug'
  AND (
    t.updated_at::timestamptz >= now() - make_interval(days => greatest(1, least(30, :'days'::integer)))
    OR t.status = 'in_progress'
  )
ORDER BY t.updated_at::timestamptz DESC
LIMIT 300;

-- persisted_at is wall-clock insertion time; created_at orders durable parts
-- and MUST NOT be used to claim model latency or sandbox cold-start duration.
-- Production samples persist assistant parts together at completion, so even
-- first_persisted_assistant_part_at is NOT time-to-first-token or first SSE.
-- Aggregate retained parts by persisted thread/run identity with recent data.
-- Hosted run_id can equal threadId and span follow-up turns: these groups are
-- NOT individual executions or attempts. Runs failing before any persisted
-- part are absent; finish presence is not proof of successful completion.
-- Correlate message IDs, fences and telemetry to diagnose individual attempts.
WITH target AS (
  SELECT id FROM organization WHERE slug = :'org_slug'
), recent_runs AS (
  SELECT DISTINCT p.org_id, p.thread_id, p.run_id
  FROM thread_message_parts p
  JOIN target o ON o.id = p.org_id
  JOIN threads t ON t.id = p.thread_id AND t.organization_id = o.id
  WHERE p.persisted_at >= now() - make_interval(days => greatest(1, least(30, :'days'::integer)))
)
SELECT p.thread_id, p.run_id,
       min(p.persisted_at) AS first_persisted_part_at,
       min(p.persisted_at) FILTER (WHERE p.role = 'assistant') AS first_persisted_assistant_part_at,
       max(p.persisted_at) AS last_persisted_part_at,
       count(*) AS parts,
       count(*) FILTER (WHERE p.kind = 'error') AS error_parts,
       count(*) FILTER (WHERE p.kind = 'finish') AS finish_parts,
       count(*) FILTER (WHERE p.persisted_at IS NULL) AS parts_without_wall_clock
FROM thread_message_parts p
JOIN recent_runs r ON r.org_id = p.org_id
                  AND r.thread_id = p.thread_id
                  AND r.run_id = p.run_id
GROUP BY p.thread_id, p.run_id
ORDER BY last_persisted_part_at DESC
LIMIT 300;

-- Upcoming work has its own rows, separate from cards and threads.
-- Do not select params/messages/models: those can contain sensitive content.
SELECT a.id AS automation_id, a.active,
       tr.id AS trigger_id, tr.type, tr.cron_expression,
       tr.last_run_at, tr.next_run_at
FROM automations a
JOIN organization o ON o.id = a.organization_id
LEFT JOIN automation_triggers tr ON tr.automation_id = a.id
WHERE o.slug = :'org_slug'
ORDER BY tr.next_run_at NULLS LAST, a.id
LIMIT 200;

ROLLBACK;
