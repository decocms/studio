package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Schema holds every table the controller owns. It may share a database with
// Studio; nothing in it is Studio's.
const Schema = "sandbox_controller"

// migrations run in order, each once, in its own transaction. Append only:
// a deployed entry never changes.
var migrations = []string{
	// 1: the sandboxes table, seeded from Studio's sandbox_runner_state when
	// that table exists, so sandboxes provisioned before the move resume
	// instead of re-provisioning. Newest row first: a handle is unique per
	// runtime here, and Studio's table allowed duplicates.
	`create table sandbox_controller.sandboxes (
		user_id     text not null,
		project_ref text not null,
		runtime     text not null,
		handle      text not null,
		state       jsonb not null,
		created_at  timestamptz not null default now(),
		updated_at  timestamptz not null default now(),
		primary key (user_id, project_ref, runtime)
	);
	create unique index sandboxes_handle_runtime on sandbox_controller.sandboxes (handle, runtime);
	do $$
	begin
		if to_regclass('sandbox_runner_state') is not null then
			insert into sandbox_controller.sandboxes (user_id, project_ref, runtime, handle, state, updated_at)
			select user_id, project_ref, sandbox_provider_kind, handle, state, updated_at
			from sandbox_runner_state
			order by updated_at desc
			on conflict do nothing;
		end if;
	end $$;`,
}

// migrationLock is any constant key shared by every replica, so two booting
// at once apply each migration once.
const migrationLock = 0x5a4d_6967_7261_7465

func migrate(ctx context.Context, pool *pgxpool.Pool) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock($1)`, int64(migrationLock)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `create schema if not exists `+Schema+`;
		create table if not exists `+Schema+`.migrations (
			version    int primary key,
			applied_at timestamptz not null default now()
		)`); err != nil {
		return err
	}
	var applied int
	if err := tx.QueryRow(ctx, `select coalesce(max(version), 0) from `+Schema+`.migrations`).Scan(&applied); err != nil {
		return err
	}
	for v := applied + 1; v <= len(migrations); v++ {
		if _, err := tx.Exec(ctx, migrations[v-1]); err != nil {
			return fmt.Errorf("migration %d: %w", v, err)
		}
		if _, err := tx.Exec(ctx, `insert into `+Schema+`.migrations (version) values ($1)`, v); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
