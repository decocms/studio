//! Shutdown-safe ownership for filesystem mutations.
//!
//! Long preparation (network fetches, catalog rendering) runs outside the
//! repository and is registered here as a cancellable owner. The only code
//! allowed to make a prepared result visible in the repository holds a short
//! [`MutationCommitPermit`]. Every admitted commit runs in a separate,
//! non-aborted task that owns its permit until the filesystem operation really
//! returns. This matters for `tokio::fs`: dropping its async waiter does not
//! cancel an already-running blocking-pool syscall. Shutdown closes both
//! admission paths synchronously, first asks every long owner to cancel
//! cooperatively, then aborts owners that exceed that grace. Only after those
//! owners retire does it cross the independent commit barrier before git
//! publish is allowed to start.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::FutureExt;
use tokio::sync::{oneshot, watch, OwnedRwLockReadGuard, RwLock};
use tokio::task::AbortHandle;
use tokio::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MutationOwnerError {
    ShuttingDown,
    Panicked,
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MutationShutdownOutcome {
    pub owners_remaining: usize,
    pub commit_quiescent: bool,
}

impl MutationShutdownOutcome {
    pub fn is_quiescent(self) -> bool {
        self.owners_remaining == 0 && self.commit_quiescent
    }
}

/// Cancellation receiver handed to a long mutation owner. Owners select on
/// [`Self::cancelled`] around every potentially long await and clean their
/// staging directory before returning.
pub struct MutationCancellation {
    receiver: watch::Receiver<bool>,
}

impl MutationCancellation {
    pub fn is_cancelled(&self) -> bool {
        *self.receiver.borrow()
    }

    pub async fn cancelled(&mut self) {
        if self.is_cancelled() {
            return;
        }
        while self.receiver.changed().await.is_ok() {
            if self.is_cancelled() {
                return;
            }
        }
    }
}

/// Proof that this short final filesystem transition linearized before
/// shutdown. The guard is intentionally opaque; dropping it ends the commit.
struct MutationCommitPermit {
    _guard: OwnedRwLockReadGuard<()>,
}

struct MutationOwnerControl {
    cancellation: watch::Sender<bool>,
    abort: AbortHandle,
}

/// Registration is retired by the owner future's destruction, not by a line
/// of code after its await. This proves all preparation locals have dropped on
/// normal return, panic, or forced abort. Final commit tasks are deliberately
/// independent: their permits remain visible through the commit barrier even
/// after the preparation owner has retired.
struct MutationOwnerCompletion {
    coordinator: Arc<MutationCoordinator>,
    id: u64,
}

impl Drop for MutationOwnerCompletion {
    fn drop(&mut self) {
        self.coordinator.finish_owner(self.id);
    }
}

pub struct MutationCoordinator {
    accepting: AtomicBool,
    commits: Arc<RwLock<()>>,
    owners: Mutex<HashMap<u64, MutationOwnerControl>>,
    owner_changes: watch::Sender<u64>,
    next_owner: AtomicU64,
}

impl MutationCoordinator {
    pub fn new() -> Self {
        let (owner_changes, _) = watch::channel(0);
        Self {
            accepting: AtomicBool::new(true),
            commits: Arc::new(RwLock::new(())),
            owners: Mutex::new(HashMap::new()),
            owner_changes,
            next_owner: AtomicU64::new(1),
        }
    }

    /// Admits one short, final repository transition. The second check after
    /// acquiring the read lock closes the queued-reader race with shutdown's
    /// writer barrier.
    async fn admit_commit(&self) -> Option<MutationCommitPermit> {
        if !self.accepting.load(Ordering::SeqCst) {
            return None;
        }
        let guard = self.commits.clone().read_owned().await;
        if !self.accepting.load(Ordering::SeqCst) {
            return None;
        }
        Some(MutationCommitPermit { _guard: guard })
    }

    /// Runs one final repository transition in a detached, non-aborted task.
    ///
    /// `tokio::fs` delegates filesystem calls to the blocking pool. Aborting
    /// the async waiter does not cancel a syscall that has already started, so
    /// a permit owned by an abortable request/preparation future could be
    /// released before the underlying rename/remove completed. The task
    /// spawned here has no exposed abort handle: caller disconnect and forced
    /// owner abort only drop the result receiver, while this task keeps the
    /// read permit until `operation` actually returns. Shutdown's write barrier
    /// therefore stays non-quiescent for the true commit lifetime.
    pub async fn run_commit<T, F, Fut>(
        self: &Arc<Self>,
        operation: F,
    ) -> Result<T, MutationOwnerError>
    where
        T: Send + 'static,
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = T> + Send + 'static,
    {
        if !self.accepting.load(Ordering::SeqCst) {
            return Err(MutationOwnerError::ShuttingDown);
        }

        let coordinator = self.clone();
        let (result_tx, result_rx) = oneshot::channel();
        tokio::spawn(async move {
            let outcome = match coordinator.admit_commit().await {
                Some(permit) => {
                    let outcome = std::panic::AssertUnwindSafe(operation())
                        .catch_unwind()
                        .await
                        .map_err(|_| MutationOwnerError::Panicked);
                    // Be explicit about the ordering proof: the operation's
                    // future is complete before the barrier permit is released.
                    drop(permit);
                    outcome
                }
                None => Err(MutationOwnerError::ShuttingDown),
            };
            let _ = result_tx.send(outcome);
        });

        result_rx.await.unwrap_or(Err(MutationOwnerError::Stopped))
    }

    /// Detaches a long preparation from its request future and registers it
    /// before spawning. Client disconnects therefore cannot orphan unknown
    /// work, and shutdown can cancel and join it through the registry.
    pub async fn run_owned<T, F, Fut>(self: &Arc<Self>, work: F) -> Result<T, MutationOwnerError>
    where
        T: Send + 'static,
        F: FnOnce(MutationCancellation) -> Fut + Send + 'static,
        Fut: Future<Output = T> + Send + 'static,
    {
        if !self.accepting.load(Ordering::SeqCst) {
            return Err(MutationOwnerError::ShuttingDown);
        }

        let id = self.next_owner.fetch_add(1, Ordering::Relaxed);
        let (cancel, receiver) = watch::channel(false);
        let (start_tx, start_rx) = oneshot::channel();
        let (result_tx, result_rx) = oneshot::channel::<Result<T, MutationOwnerError>>();
        // The start gate keeps user work dormant until its cancellation and
        // abort controls are both visible in the registry.
        let owner_task = tokio::spawn(async move {
            if start_rx.await.is_err() {
                return None;
            }
            Some(
                std::panic::AssertUnwindSafe(work(MutationCancellation { receiver }))
                    .catch_unwind()
                    .await,
            )
        });
        let abort = owner_task.abort_handle();

        let completion = MutationOwnerCompletion {
            coordinator: self.clone(),
            id,
        };
        // A separate completion owner holds the JoinHandle. `JoinHandle::await`
        // becomes ready only after the preparation future has returned or has
        // actually been dropped by abort. Registry retirement therefore cannot
        // race ahead of destruction of the work future it represents.
        tokio::spawn(async move {
            let outcome = match owner_task.await {
                Ok(Some(Ok(value))) => Ok(value),
                Ok(Some(Err(_))) => Err(MutationOwnerError::Panicked),
                Ok(None) | Err(_) => Err(MutationOwnerError::Stopped),
            };
            drop(completion);
            let _ = result_tx.send(outcome);
        });

        {
            let mut owners = match self.owners.lock() {
                Ok(owners) => owners,
                Err(poisoned) => poisoned.into_inner(),
            };
            if !self.accepting.load(Ordering::SeqCst) {
                drop(owners);
                abort.abort();
                return Err(MutationOwnerError::ShuttingDown);
            }
            owners.insert(
                id,
                MutationOwnerControl {
                    cancellation: cancel,
                    abort,
                },
            );
        }
        let _ = start_tx.send(());

        result_rx.await.unwrap_or(Err(MutationOwnerError::Stopped))
    }

    /// Synchronously closes admission and signals all registered owners. The
    /// returned future gives cooperative cleanup one `budget`, force-aborts
    /// the remaining task futures, then gives actual future destruction a
    /// second `budget`. The commit barrier shares whichever owner phase is
    /// active: registration removal therefore happens before a true terminal
    /// outcome, and a false outcome remains a hard publish gate.
    pub fn begin_shutdown(
        &self,
        budget: Duration,
    ) -> impl Future<Output = MutationShutdownOutcome> + '_ {
        self.accepting.store(false, Ordering::SeqCst);
        let cooperative_deadline = Instant::now() + budget;
        let cancellations: Vec<watch::Sender<bool>> = {
            let owners = match self.owners.lock() {
                Ok(owners) => owners,
                Err(poisoned) => poisoned.into_inner(),
            };
            owners
                .values()
                .map(|owner| owner.cancellation.clone())
                .collect()
        };
        for cancellation in cancellations {
            let _ = cancellation.send(true);
        }

        async move {
            let mut barrier_deadline = cooperative_deadline;
            let mut owners_remaining = self.wait_for_owners(cooperative_deadline).await;
            if owners_remaining > 0 {
                let aborts: Vec<AbortHandle> = {
                    let owners = match self.owners.lock() {
                        Ok(owners) => owners,
                        Err(poisoned) => poisoned.into_inner(),
                    };
                    owners.values().map(|owner| owner.abort.clone()).collect()
                };
                for abort in aborts {
                    abort.abort();
                }
                barrier_deadline = Instant::now() + budget;
                owners_remaining = self.wait_for_owners(barrier_deadline).await;
            }
            let commit_quiescent = tokio::time::timeout_at(barrier_deadline, self.commits.write())
                .await
                .is_ok();
            MutationShutdownOutcome {
                owners_remaining,
                commit_quiescent,
            }
        }
    }

    fn finish_owner(&self, id: u64) {
        let removed = {
            let mut owners = match self.owners.lock() {
                Ok(owners) => owners,
                Err(poisoned) => poisoned.into_inner(),
            };
            owners.remove(&id).is_some()
        };
        if removed {
            self.owner_changes
                .send_modify(|generation| *generation += 1);
        }
    }

    async fn wait_for_owners(&self, deadline: Instant) -> usize {
        let mut changes = self.owner_changes.subscribe();
        loop {
            let remaining = match self.owners.lock() {
                Ok(owners) => owners.len(),
                Err(poisoned) => poisoned.into_inner().len(),
            };
            if remaining == 0 {
                return 0;
            }
            if tokio::time::timeout_at(deadline, changes.changed())
                .await
                .is_err()
            {
                return match self.owners.lock() {
                    Ok(owners) => owners.len(),
                    Err(poisoned) => poisoned.into_inner().len(),
                };
            }
        }
    }
}

impl Default for MutationCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    struct DropProbe(Arc<AtomicBool>);

    impl Drop for DropProbe {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn shutdown_waits_for_an_admitted_commit_before_quiescence() {
        let coordinator = Arc::new(MutationCoordinator::new());
        let permit = coordinator.admit_commit().await.expect("commit admitted");
        let shutting_down = {
            let coordinator = coordinator.clone();
            tokio::spawn(async move { coordinator.begin_shutdown(Duration::from_secs(1)).await })
        };
        tokio::task::yield_now().await;
        assert!(!shutting_down.is_finished());
        assert!(coordinator.admit_commit().await.is_none());

        drop(permit);
        assert!(shutting_down.await.unwrap().is_quiescent());
    }

    #[tokio::test]
    async fn shutdown_cancels_and_joins_long_owner_cleanup() {
        let coordinator = Arc::new(MutationCoordinator::new());
        let cleaned = Arc::new(AtomicBool::new(false));
        let owner_cleaned = cleaned.clone();
        let (started_tx, started_rx) = oneshot::channel();
        let owner = {
            let coordinator = coordinator.clone();
            tokio::spawn(async move {
                coordinator
                    .run_owned(move |mut cancellation| async move {
                        let _ = started_tx.send(());
                        cancellation.cancelled().await;
                        owner_cleaned.store(true, Ordering::SeqCst);
                        "cancelled"
                    })
                    .await
            })
        };
        started_rx.await.unwrap();

        let outcome = coordinator.begin_shutdown(Duration::from_secs(1)).await;
        assert!(outcome.is_quiescent());
        assert!(cleaned.load(Ordering::SeqCst));
        assert_eq!(owner.await.unwrap().unwrap(), "cancelled");
    }

    #[tokio::test]
    async fn ignored_cooperative_cancellation_is_force_aborted_and_quiescent() {
        let coordinator = Arc::new(MutationCoordinator::new());
        let (started_tx, started_rx) = oneshot::channel();
        let owner = {
            let coordinator = coordinator.clone();
            tokio::spawn(async move {
                coordinator
                    .run_owned(move |_cancellation| async move {
                        let _ = started_tx.send(());
                        std::future::pending::<()>().await;
                    })
                    .await
            })
        };
        started_rx.await.unwrap();

        let outcome = coordinator.begin_shutdown(Duration::from_millis(50)).await;
        assert!(outcome.is_quiescent());
        assert_eq!(owner.await.unwrap(), Err(MutationOwnerError::Stopped));
    }

    #[tokio::test]
    async fn forced_abort_drops_the_owned_preparation_before_quiescence() {
        let coordinator = Arc::new(MutationCoordinator::new());
        let dropped = Arc::new(AtomicBool::new(false));
        let owner_dropped = dropped.clone();
        let (started_tx, started_rx) = oneshot::channel();
        let owner = {
            let coordinator = coordinator.clone();
            tokio::spawn(async move {
                coordinator
                    .run_owned(move |_cancellation| async move {
                        let _probe = DropProbe(owner_dropped);
                        let _ = started_tx.send(());
                        std::future::pending::<()>().await;
                    })
                    .await
            })
        };
        started_rx.await.unwrap();

        let outcome = coordinator.begin_shutdown(Duration::from_millis(50)).await;
        assert!(outcome.is_quiescent());
        assert!(
            dropped.load(Ordering::SeqCst),
            "quiescence was reported before the owner future's locals dropped"
        );
        assert_eq!(owner.await.unwrap(), Err(MutationOwnerError::Stopped));
    }

    #[tokio::test]
    async fn forced_owner_abort_cannot_release_an_in_flight_commit_barrier() {
        let coordinator = Arc::new(MutationCoordinator::new());
        let (commit_started_tx, commit_started_rx) = oneshot::channel();
        let (release_commit_tx, release_commit_rx) = oneshot::channel();
        let owner = {
            let coordinator = coordinator.clone();
            tokio::spawn(async move {
                let commit_coordinator = coordinator.clone();
                coordinator
                    .run_owned(move |_cancellation| async move {
                        commit_coordinator
                            .run_commit(move || async move {
                                let _ = commit_started_tx.send(());
                                let _ = release_commit_rx.await;
                                "committed"
                            })
                            .await
                    })
                    .await
            })
        };
        commit_started_rx.await.unwrap();

        let first = coordinator.begin_shutdown(Duration::from_millis(25)).await;
        assert_eq!(first.owners_remaining, 0);
        assert!(
            !first.commit_quiescent,
            "forced owner abort must not hide the detached commit task"
        );
        assert_eq!(owner.await.unwrap(), Err(MutationOwnerError::Stopped));

        release_commit_tx.send(()).unwrap();
        let second = coordinator.begin_shutdown(Duration::from_secs(1)).await;
        assert!(
            second.is_quiescent(),
            "commit barrier did not release after the real operation completed"
        );
    }

    #[tokio::test]
    async fn caller_disconnect_does_not_orphan_detached_owner() {
        let coordinator = Arc::new(MutationCoordinator::new());
        let cleaned = Arc::new(AtomicBool::new(false));
        let owner_cleaned = cleaned.clone();
        let (started_tx, started_rx) = oneshot::channel();
        let caller = {
            let coordinator = coordinator.clone();
            tokio::spawn(async move {
                coordinator
                    .run_owned(move |mut cancellation| async move {
                        let _ = started_tx.send(());
                        cancellation.cancelled().await;
                        owner_cleaned.store(true, Ordering::SeqCst);
                    })
                    .await
            })
        };
        started_rx.await.unwrap();

        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        let outcome = coordinator.begin_shutdown(Duration::from_secs(1)).await;
        assert!(outcome.is_quiescent());
        assert!(
            cleaned.load(Ordering::SeqCst),
            "dropping the request waiter must not detach owner state from shutdown"
        );
    }
}
