//! Graceful-shutdown hook registry.
//!
//! The daemon's `entry.ts::shutdown()` runs a git publish ("sync all local
//! changes to remote") BEFORE unmounting org-fs, on SIGTERM, with the
//! reasoning that syncing the user's work is the only irrecoverable step —
//! see the comment above `shutdown()` in `packages/sandbox/daemon/entry.ts`.
//! Local-api needs the same shape (the git family's e2e asserts a
//! shutdown-triggered publish) but must not let the `git` module reach into
//! `main.rs` to register itself — that would make `main.rs` a shared file
//! every family edits. Instead, `main.rs` owns one `ShutdownCoordinator` in
//! `AppState` and calls `run()` after the SIGTERM signal fires; any family
//! that needs a shutdown-time action calls `state.shutdown.register(..)`
//! from its own route-registration code (e.g. `routes::git::register`, if
//! that family adds one) without ever touching `main.rs`.
//!
//! Hooks are NOT retried and NOT guaranteed to run under SIGKILL. The native
//! queue lifecycle black-box suite delivers a real SIGTERM to pin the graceful
//! path; crash-recovery tests use SIGKILL separately to pin the watchdog path.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::FutureExt;
use tokio::sync::{RwLock, RwLockReadGuard};
use tokio::time::Instant;

use crate::mutation::MutationCoordinator;

pub type ShutdownHook = Box<dyn Fn() -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

pub struct ShutdownCoordinator {
    hooks: Mutex<Vec<ShutdownHook>>,
    accepting_work: AtomicBool,
    admission: RwLock<()>,
    mutations: Arc<MutationCoordinator>,
}

impl ShutdownCoordinator {
    pub fn new() -> Self {
        Self {
            hooks: Mutex::new(Vec::new()),
            accepting_work: AtomicBool::new(true),
            admission: RwLock::new(()),
            mutations: Arc::new(MutationCoordinator::new()),
        }
    }

    /// Filesystem mutation lifecycle owned by the same top-level shutdown
    /// coordinator. Kept behind this accessor so `AppState` test fixtures do
    /// not need a second independently-constructed shutdown component.
    pub(crate) fn mutations(&self) -> Arc<MutationCoordinator> {
        self.mutations.clone()
    }

    /// Enters a short critical section that must finish before shutdown takes
    /// its process-local snapshot. The first atomic check avoids queueing new
    /// readers behind a shutdown writer; the second check closes the race where
    /// shutdown starts while this task is waiting for the read lock.
    ///
    /// Keep the returned guard alive through the durable enqueue and worker
    /// launch. That makes the boundary linear: either the work is visible to
    /// the shutdown hook's snapshot, or it is rejected before being accepted.
    pub async fn admit_work(&self) -> Option<RwLockReadGuard<'_, ()>> {
        if !self.accepting_work.load(Ordering::SeqCst) {
            return None;
        }
        let guard = self.admission.read().await;
        if !self.accepting_work.load(Ordering::SeqCst) {
            return None;
        }
        Some(guard)
    }

    /// First, idempotent phase of process shutdown. Calling this method
    /// synchronously flips the admission bit before it returns the barrier
    /// future; awaiting that future then waits for short sections that already
    /// won the race (spawn + durable registry insertion) to finish. This split
    /// lets the top-level owner close setup queues before its first await.
    pub fn begin_shutdown(&self) -> impl Future<Output = ()> + '_ {
        self.accepting_work.store(false, Ordering::SeqCst);
        async move {
            let barrier = self.admission.write().await;
            drop(barrier);
        }
    }

    /// Register a hook to run once, in registration order, during graceful
    /// shutdown. Hooks should still log their own expected errors, but this
    /// coordinator isolates both a panic and a timeout so neither can suppress
    /// later cleanup.
    pub fn register(&self, hook: ShutdownHook) {
        match self.hooks.lock() {
            Ok(mut hooks) => hooks.push(hook),
            Err(poisoned) => poisoned.into_inner().push(hook),
        }
    }

    /// Drain and run every registered hook in registration order. Panics are
    /// isolated so one family cannot suppress later cleanup, and the complete
    /// ordered pipeline has one wall-clock deadline rather than multiplying a
    /// timeout by the number of hooks.
    pub async fn run(&self) {
        self.run_with_deadline(Duration::from_secs(20)).await;
    }

    async fn run_with_deadline(&self, budget: Duration) {
        self.begin_shutdown().await;
        let hooks: Vec<ShutdownHook> = {
            let mut guard = match self.hooks.lock() {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            };
            std::mem::take(&mut *guard)
        };
        let deadline = Instant::now() + budget;
        let hook_count = hooks.len();
        for (index, hook) in hooks.into_iter().enumerate() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            // Reserve an equal share of the remaining global budget for every
            // later hook. A wedged early hook must not suppress git publish or
            // child-process finalization; each hook is attempted in order while
            // the sum of their slices remains bounded by `budget`.
            let hooks_left = u32::try_from(hook_count - index).unwrap_or(u32::MAX);
            let hook_budget = remaining / hooks_left;
            let guarded = std::panic::AssertUnwindSafe(async move { hook().await }).catch_unwind();
            match tokio::time::timeout(hook_budget, guarded).await {
                Ok(Ok(())) => {}
                Ok(Err(_panic)) => {
                    tracing::error!(hook_index = index, "shutdown hook panicked; continuing")
                }
                Err(_) => {
                    tracing::error!(
                        hook_index = index,
                        ?hook_budget,
                        "shutdown hook exceeded its reserved deadline; continuing"
                    );
                }
            }
        }
    }
}

impl Default for ShutdownCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[tokio::test]
    async fn admission_linearizes_in_flight_work_before_shutdown_hooks() {
        let coordinator = Arc::new(ShutdownCoordinator::new());
        let admitted = coordinator.admit_work().await.expect("admitted work");
        let order = Arc::new(Mutex::new(Vec::new()));
        let hook_order = order.clone();
        coordinator.register(Box::new(move || {
            let hook_order = hook_order.clone();
            Box::pin(async move { hook_order.lock().unwrap().push("hook") })
        }));

        let runner = {
            let coordinator = coordinator.clone();
            tokio::spawn(async move {
                coordinator.run_with_deadline(Duration::from_secs(1)).await;
            })
        };
        while coordinator.accepting_work.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
        assert!(order.lock().unwrap().is_empty());
        assert!(coordinator.admit_work().await.is_none());

        order.lock().unwrap().push("admitted");
        drop(admitted);
        runner.await.unwrap();
        assert_eq!(*order.lock().unwrap(), ["admitted", "hook"]);
    }

    #[tokio::test]
    async fn begin_shutdown_is_idempotent_and_permanently_closes_admission() {
        let coordinator = ShutdownCoordinator::new();
        let first_barrier = coordinator.begin_shutdown();
        assert!(
            coordinator.admit_work().await.is_none(),
            "admission closes synchronously before the barrier is awaited"
        );
        first_barrier.await;
        coordinator.begin_shutdown().await;
        assert!(coordinator.admit_work().await.is_none());
    }

    #[tokio::test]
    async fn hook_panic_isolated_and_order_continues() {
        let coordinator = ShutdownCoordinator::new();
        let order = Arc::new(Mutex::new(Vec::new()));
        let first = order.clone();
        coordinator.register(Box::new(move || {
            let first = first.clone();
            Box::pin(async move {
                first.lock().unwrap().push(1);
                panic!("synthetic shutdown panic");
            })
        }));
        let second = order.clone();
        coordinator.register(Box::new(move || {
            let second = second.clone();
            Box::pin(async move { second.lock().unwrap().push(2) })
        }));

        coordinator.run_with_deadline(Duration::from_secs(1)).await;
        assert_eq!(*order.lock().unwrap(), [1, 2]);
    }

    #[tokio::test]
    async fn all_hooks_share_one_wall_clock_deadline() {
        let coordinator = ShutdownCoordinator::new();
        coordinator.register(Box::new(|| {
            Box::pin(async { std::future::pending::<()>().await })
        }));
        let later_order = Arc::new(Mutex::new(Vec::new()));
        let second_order = later_order.clone();
        coordinator.register(Box::new(move || {
            let second_order = second_order.clone();
            Box::pin(async move { second_order.lock().unwrap().push(2) })
        }));
        let third_order = later_order.clone();
        coordinator.register(Box::new(move || {
            let third_order = third_order.clone();
            Box::pin(async move { third_order.lock().unwrap().push(3) })
        }));
        let started = Instant::now();
        coordinator
            .run_with_deadline(Duration::from_millis(30))
            .await;
        assert!(
            started.elapsed() < Duration::from_millis(100),
            "deadline must be global, not multiplied per hook"
        );
        assert_eq!(
            *later_order.lock().unwrap(),
            [2, 3],
            "a hanging earlier hook must not suppress second or third cleanup"
        );
    }
}
