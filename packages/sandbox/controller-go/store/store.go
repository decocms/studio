// Package store owns sandbox_runner_state: one row per (user, projectRef,
// runtime), the runtime recorded in sandbox_provider_kind. The state column is
// a runtime-private JSON blob.
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

	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
)

// Record is one persisted sandbox.
type Record struct {
	ID        protocol.SandboxID
	Handle    string
	Runtime   string
	State     json.RawMessage
	UpdatedAt time.Time
}

// Store is the persistence the runtimes and the server need. Calls made with
// the context WithLock hands its callback run on the lock's transaction.
type Store interface {
	Get(ctx context.Context, id protocol.SandboxID, runtime string) (*Record, error)
	// GetAnyRuntime finds the sandbox on whichever runtime holds it, so an
	// ensure stays idempotent across a runtime the request did not name.
	GetAnyRuntime(ctx context.Context, id protocol.SandboxID) (*Record, error)
	ByHandle(ctx context.Context, handle string) (*Record, error)
	Put(ctx context.Context, id protocol.SandboxID, runtime, handle string, state any) error
	Delete(ctx context.Context, id protocol.SandboxID, runtime string) error
	DeleteByHandle(ctx context.Context, runtime, handle string) error
	ListByRuntime(ctx context.Context, runtime string) ([]Record, error)
	// WithLock serializes ensure for one sandbox across replicas, and against
	// Studio's in-process runner, which takes the same key.
	WithLock(ctx context.Context, id protocol.SandboxID, runtime string, fn func(context.Context) error) error
}

type Postgres struct{ pool *pgxpool.Pool }

var _ Store = (*Postgres)(nil)

// queryer is what both *pgxpool.Pool and pgx.Tx offer.
type queryer interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

type txKey struct{}

// exec routes onto WithLock's transaction when the context carries one. The
// lock pins a connection for a provision that runs for minutes; if the
// callback's own queries each took a second connection, MaxConns concurrent
// ensures would deadlock the pool.
func (s *Postgres) exec(ctx context.Context) queryer {
	if tx, ok := ctx.Value(txKey{}).(pgx.Tx); ok {
		return tx
	}
	return s.pool
}

func NewPostgres(ctx context.Context, dsn string) (*Postgres, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("database unreachable: %w", err)
	}
	return &Postgres{pool: pool}, nil
}

func (s *Postgres) Close() { s.pool.Close() }

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

func (s *Postgres) Get(ctx context.Context, id protocol.SandboxID, runtime string) (*Record, error) {
	return scan(s.exec(ctx).QueryRow(ctx,
		`select `+selectCols+` from sandbox_runner_state
		 where user_id = $1 and project_ref = $2 and sandbox_provider_kind = $3`,
		id.UserID, id.ProjectRef, runtime))
}

func (s *Postgres) GetAnyRuntime(ctx context.Context, id protocol.SandboxID) (*Record, error) {
	return scan(s.exec(ctx).QueryRow(ctx,
		`select `+selectCols+` from sandbox_runner_state
		 where user_id = $1 and project_ref = $2 order by updated_at desc limit 1`,
		id.UserID, id.ProjectRef))
}

func (s *Postgres) ByHandle(ctx context.Context, handle string) (*Record, error) {
	return scan(s.exec(ctx).QueryRow(ctx,
		`select `+selectCols+` from sandbox_runner_state where handle = $1`, handle))
}

func (s *Postgres) Put(ctx context.Context, id protocol.SandboxID, runtime, handle string, state any) error {
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

func (s *Postgres) Delete(ctx context.Context, id protocol.SandboxID, runtime string) error {
	_, err := s.exec(ctx).Exec(ctx,
		`delete from sandbox_runner_state
		 where user_id = $1 and project_ref = $2 and sandbox_provider_kind = $3`,
		id.UserID, id.ProjectRef, runtime)
	return err
}

func (s *Postgres) DeleteByHandle(ctx context.Context, runtime, handle string) error {
	_, err := s.exec(ctx).Exec(ctx,
		`delete from sandbox_runner_state where sandbox_provider_kind = $1 and handle = $2`,
		runtime, handle)
	return err
}

func (s *Postgres) ListByRuntime(ctx context.Context, runtime string) ([]Record, error) {
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

// LockWait bounds the advisory-lock wait: long enough to cover a provision
// running inside the lock, short enough that a stuck holder is visible.
const LockWait = 90 * time.Second

// LockKey hashes (userId, projectRef, runtime) into pg's signed bigint, byte
// for byte what Studio's KyselySandboxProviderStateStore computes for
// agent-sandbox, so the two writers exclude each other.
func LockKey(id protocol.SandboxID, runtime string) int64 {
	h := sha256.New()
	h.Write([]byte(id.UserID))
	h.Write([]byte{0})
	h.Write([]byte(id.ProjectRef))
	h.Write([]byte{0})
	h.Write([]byte(runtime))
	return int64(binary.BigEndian.Uint64(h.Sum(nil)[:8]))
}

// WithLock holds pg_advisory_xact_lock for fn. Transactional, so commit,
// rollback or a dropped connection all release it; the wait is bounded with
// SET LOCAL statement_timeout, cleared before fn runs.
func (s *Postgres) WithLock(ctx context.Context, id protocol.SandboxID, runtime string, fn func(context.Context) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	if _, err := tx.Exec(ctx, fmt.Sprintf("set local statement_timeout = %d", LockWait.Milliseconds())); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock($1)`, LockKey(id, runtime)); err != nil {
		return fmt.Errorf("sandbox advisory lock busy >%s for user=%s projectRef=%s runtime=%s; retry shortly: %w",
			LockWait, id.UserID, id.ProjectRef, runtime, err)
	}
	if _, err := tx.Exec(ctx, "set local statement_timeout = 0"); err != nil {
		return err
	}
	if err := fn(context.WithValue(ctx, txKey{}, tx)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
