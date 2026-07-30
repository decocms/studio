//! Graceful-shutdown admission control.
//!
//! `main.rs` owns one `ShutdownCoordinator` in `AppState`. Request paths that
//! start side-effecting work enter a short critical section via
//! [`ShutdownCoordinator::admit_work`]; the top-level shutdown pipeline in
//! `lib.rs::ServerHandle::shutdown` calls [`ShutdownCoordinator::begin_shutdown`]
//! to close admission and wait for sections that already won the race, then
//! runs its explicit ordered reap/drain phases inline.
//!
//! There is deliberately no shutdown-hook registry here anymore: its only
//! production registrant was the git publish-on-close hook, removed because
//! local worktrees are durable across launches (see `routes/git.rs`'s
//! "No publish on shutdown" section). Nothing here is guaranteed to run
//! under SIGKILL; crash recovery is the watchdog's job.

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::{RwLock, RwLockReadGuard};

use crate::mutation::MutationCoordinator;

pub struct ShutdownCoordinator {
    accepting_work: AtomicBool,
    admission: RwLock<()>,
    mutations: Arc<MutationCoordinator>,
}

impl ShutdownCoordinator {
    pub fn new() -> Self {
        Self {
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
    /// shutdown's snapshot, or it is rejected before being accepted.
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
}

impl Default for ShutdownCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn admission_linearizes_in_flight_work_before_shutdown_barrier() {
        let coordinator = Arc::new(ShutdownCoordinator::new());
        let admitted = coordinator.admit_work().await.expect("admitted work");
        let order = Arc::new(Mutex::new(Vec::new()));

        let runner = {
            let coordinator = coordinator.clone();
            let barrier_order = order.clone();
            tokio::spawn(async move {
                coordinator.begin_shutdown().await;
                barrier_order.lock().unwrap().push("barrier");
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
        assert_eq!(*order.lock().unwrap(), ["admitted", "barrier"]);
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
}
