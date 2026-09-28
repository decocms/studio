package store

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
)

// Needs a disposable Postgres: STORE_TEST_DATABASE_URL, whose public and
// sandbox_controller schemas the test drops.
func TestMigrationSeedsFromStudioAndIsIdempotent(t *testing.T) {
	dsn := os.Getenv("STORE_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("STORE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	raw, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	if _, err := raw.Exec(ctx, `drop schema if exists sandbox_controller cascade;
		drop table if exists sandbox_runner_state;
		create table sandbox_runner_state (
			user_id text not null, project_ref text not null, sandbox_provider_kind text not null,
			handle text not null, state jsonb not null,
			created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
			primary key (user_id, project_ref, sandbox_provider_kind));
		insert into sandbox_runner_state (user_id, project_ref, sandbox_provider_kind, handle, state, updated_at) values
			('u2', 'r2', 'agent-sandbox', 'h1', '{"token":"old"}', now() - interval '1 hour'),
			('u1', 'r1', 'agent-sandbox', 'h1', '{"token":"new"}', now()),
			('u3', 'r3', 'agent-sandbox', 'h3', '{"token":"t3"}', now())`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = raw.Exec(ctx, `drop schema if exists sandbox_controller cascade; drop table if exists sandbox_runner_state`)
	})

	st, err := NewPostgres(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	// A duplicate handle keeps the newest row.
	if r, err := st.ByHandle(ctx, "h1"); err != nil || r == nil || r.ID.UserID != "u1" || string(r.State) != `{"token": "new"}` {
		t.Fatalf("h1 = %+v, %v", r, err)
	}
	if r, _ := st.Get(ctx, protocol.SandboxID{UserID: "u3", ProjectRef: "r3"}, "agent-sandbox"); r == nil {
		t.Fatal("u3 not copied")
	}

	// A second boot neither re-copies nor resurrects a deleted row.
	if err := st.Delete(ctx, protocol.SandboxID{UserID: "u3", ProjectRef: "r3"}, "agent-sandbox"); err != nil {
		t.Fatal(err)
	}
	again, err := NewPostgres(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	if r, _ := again.Get(ctx, protocol.SandboxID{UserID: "u3", ProjectRef: "r3"}, "agent-sandbox"); r != nil {
		t.Fatal("second boot re-copied a deleted row")
	}
	var n int
	if err := raw.QueryRow(ctx, `select count(*) from sandbox_controller.migrations`).Scan(&n); err != nil || n != len(migrations) {
		t.Fatalf("migrations recorded = %d, %v", n, err)
	}
}

func TestMigrationWithoutStudioTable(t *testing.T) {
	dsn := os.Getenv("STORE_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("STORE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	raw, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	if _, err := raw.Exec(ctx, `drop schema if exists sandbox_controller cascade; drop table if exists sandbox_runner_state`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = raw.Exec(ctx, `drop schema if exists sandbox_controller cascade`) })
	st, err := NewPostgres(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	id := protocol.SandboxID{UserID: "u", ProjectRef: "r"}
	if err := st.Put(ctx, id, "docker", "h", map[string]string{"a": "b"}); err != nil {
		t.Fatal(err)
	}
	if err := st.Put(ctx, protocol.SandboxID{UserID: "other", ProjectRef: "r"}, "docker", "h", map[string]string{}); err == nil {
		t.Fatal("a second sandbox took the same handle on one runtime")
	}
	if err := st.WithLock(ctx, id, "docker", func(ctx context.Context) error {
		r, err := st.Get(ctx, id, "docker")
		if r == nil {
			t.Error("row not visible inside the lock")
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}
