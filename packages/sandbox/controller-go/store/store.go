// Package store owns sandbox_runner_state — the one table the controller took
// from studio. Same Postgres, same rows; the table is the ownership boundary.
package store

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/decocms/studio/sandbox-controller/protocol"
)

// Record is one persisted sandbox. State is an opaque runtime-private blob.
type Record struct {
	ID        protocol.SandboxID
	Handle    string
	Runtime   string
	State     json.RawMessage
	UpdatedAt time.Time
}

type Store struct{ pool *pgxpool.Pool }

// queryer is the slice of pgx both *pgxpool.Pool and pgx.Tx implement.
type queryer interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

type txKey struct{}

// exec routes a query onto WithLock's transaction when one is in the context,
// and onto the pool otherwise.
//
// This is what stops the nested-query pool deadlock: WithLock pins one
// connection for the whole callback, and provisioning inside it runs for
// minutes. If the callback's own reads and writes each grabbed a second
// connection, `MaxConns` concurrent ensures would hold every connection while
// all of them waited for one more.
func (s *Store) exec(ctx context.Context) queryer {
	if tx, ok := ctx.Value(txKey{}).(pgx.Tx); ok {
		return tx
	}
	return s.pool
}

func New(ctx context.Context, dsn string) (*Store, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		return nil, fmt.Errorf("database unreachable: %w", err)
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() { s.pool.Close() }

const selectCols = `user_id, project_ref, sandbox_provider_kind, handle, state, updated_at`

func scan(row pgx.Row) (*Record, error) {
	var r Record
	if err := row.Scan(&r.ID.UserID, &r.ID.ProjectRef, &r.Runtime, &r.Handle, &r.State, &r.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &r, nil
}

// Get returns the row for this sandbox on this runtime, nil when absent.
func (s *Store) Get(ctx context.Context, id protocol.SandboxID, runtime string) (*Record, error) {
	return scan(s.exec(ctx).QueryRow(ctx,
		`select `+selectCols+` from sandbox_runner_state
		 where user_id = $1 and project_ref = $2 and sandbox_provider_kind = $3`,
		id.UserID, id.ProjectRef, runtime))
}

// GetAnyRuntime finds this sandbox on whichever runtime holds it. Ensure uses
// it to stay idempotent across a runtime the request did not name.
func (s *Store) GetAnyRuntime(ctx context.Context, id protocol.SandboxID) (*Record, error) {
	return scan(s.exec(ctx).QueryRow(ctx,
		`select `+selectCols+` from sandbox_runner_state
		 where user_id = $1 and project_ref = $2 limit 1`,
		id.UserID, id.ProjectRef))
}

// ByHandle answers "which runtime owns this handle" for every post-create call.
func (s *Store) ByHandle(ctx context.Context, handle string) (*Record, error) {
	return scan(s.exec(ctx).QueryRow(ctx,
		`select `+selectCols+` from sandbox_runner_state where handle = $1`, handle))
}

func (s *Store) Put(ctx context.Context, id protocol.SandboxID, runtime, handle string, state any) error {
	blob, err := json.Marshal(state)
	if err != nil {
		return err
	}
	_, err = s.exec(ctx).Exec(ctx,
		`insert into sandbox_runner_state
		   (user_id, project_ref, sandbox_provider_kind, handle, state, updated_at)
		 values ($1, $2, $3, $4, $5, now())
		 on conflict (user_id, project_ref, sandbox_provider_kind)
		 do update set handle = excluded.handle, state = excluded.state, updated_at = now()`,
		id.UserID, id.ProjectRef, runtime, handle, blob)
	return err
}

func (s *Store) DeleteByHandle(ctx context.Context, runtime, handle string) error {
	_, err := s.exec(ctx).Exec(ctx,
		`delete from sandbox_runner_state where sandbox_provider_kind = $1 and handle = $2`,
		runtime, handle)
	return err
}

// ListByRuntime is what the credential refresher walks.
func (s *Store) ListByRuntime(ctx context.Context, runtime string) ([]Record, error) {
	rows, err := s.exec(ctx).Query(ctx,
		`select `+selectCols+` from sandbox_runner_state where sandbox_provider_kind = $1`, runtime)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Record
	for rows.Next() {
		var r Record
		if err := rows.Scan(&r.ID.UserID, &r.ID.ProjectRef, &r.Runtime, &r.Handle, &r.State, &r.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// lockWait bounds the advisory-lock wait. Generous enough to cover a full
// provision (the holder runs it inside the lock), short enough that a stuck
// holder is visible rather than wedging every concurrent ensure.
const lockWait = 90 * time.Second

// lockKey hashes (userId, projectRef, runtime) into pg's signed bigint range.
func lockKey(id protocol.SandboxID, runtime string) int64 {
	h := sha256.New()
	h.Write([]byte(id.UserID))
	h.Write([]byte{0})
	h.Write([]byte(id.ProjectRef))
	h.Write([]byte{0})
	h.Write([]byte(runtime))
	return int64(binary.BigEndian.Uint64(h.Sum(nil)[:8]))
}

// WithLock serializes ensure() for one sandbox across controller replicas.
//
// pg_advisory_xact_lock is transactional — released on commit, rollback OR
// connection loss — so a crashed replica never strands a sandbox. The wait is
// bounded via SET LOCAL statement_timeout, then cleared before fn runs so the
// callback's own queries are not capped by the lock-wait budget.
func (s *Store) WithLock(ctx context.Context, id protocol.SandboxID, runtime string, fn func(context.Context) error) error {
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()

	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, fmt.Sprintf("set local statement_timeout = %d", lockWait.Milliseconds())); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock($1)`, lockKey(id, runtime)); err != nil {
		return fmt.Errorf("sandbox advisory lock busy >%s for user=%s projectRef=%s runtime=%s — provisioner is slow or stuck; retry shortly: %w",
			lockWait, id.UserID, id.ProjectRef, runtime, err)
	}
	if _, err := tx.Exec(ctx, "set local statement_timeout = 0"); err != nil {
		return err
	}
	if err := fn(context.WithValue(ctx, txKey{}, tx)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
