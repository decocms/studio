//! Lock acquisition that survives a poisoned mutex.
//!
//! ## The policy, decided once
//!
//! A `std::sync::Mutex` is poisoned when a thread panics while holding it.
//! `lock().unwrap()` — the shape this module replaces at ~40 call sites —
//! turns that into a SECOND panic in whichever thread touches the lock next.
//! In a desktop app that cascade is the worst available outcome: one panicked
//! background task takes down the request path, the task registry, and the
//! event stream with it, and unwinding poisons every other lock on the way
//! out.
//!
//! Every lock in this workspace guards plain, self-consistent data — a queue
//! of turns, an `Option<CancelHandle>`, a cookie map, a cached session. None
//! of them carry a cross-field invariant that a mid-update panic could leave
//! half-applied in a way a later reader would misinterpret. So the useful
//! reading of poison here is "some other task died", which is the panicking
//! task's problem to report, not a reason to spread the failure.
//!
//! `PoisonError::into_inner` is therefore the policy: take the guard and
//! carry on. This is the same choice `parking_lot` makes by not having
//! poisoning at all.
//!
//! If a future lock DOES guard a multi-field invariant, that lock should not
//! use these helpers — it should handle `PoisonError` explicitly and decide
//! what a half-applied update means for it.

use std::sync::{Mutex, MutexGuard, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard};

/// [`Mutex::lock`] that ignores poisoning — see the module docs.
pub trait MutexExt<T: ?Sized> {
    /// Locks, recovering the guard if a previous holder panicked.
    fn lock_ok(&self) -> MutexGuard<'_, T>;
}

impl<T: ?Sized> MutexExt<T> for Mutex<T> {
    fn lock_ok(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// [`RwLock::read`]/[`RwLock::write`] that ignore poisoning — see the module
/// docs.
pub trait RwLockExt<T: ?Sized> {
    /// Read-locks, recovering the guard if a previous writer panicked.
    fn read_ok(&self) -> RwLockReadGuard<'_, T>;
    /// Write-locks, recovering the guard if a previous writer panicked.
    fn write_ok(&self) -> RwLockWriteGuard<'_, T>;
}

impl<T: ?Sized> RwLockExt<T> for RwLock<T> {
    fn read_ok(&self) -> RwLockReadGuard<'_, T> {
        self.read().unwrap_or_else(PoisonError::into_inner)
    }

    fn write_ok(&self) -> RwLockWriteGuard<'_, T> {
        self.write().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// The whole point: a panic under the lock must not make the NEXT
    /// acquisition fail. Without `into_inner` both asserts below panic.
    #[test]
    fn recovers_the_guard_after_a_holder_panics() {
        let m = Arc::new(Mutex::new(vec![1_u8]));
        let poisoner = Arc::clone(&m);
        let _ = std::thread::spawn(move || {
            let mut g = poisoner.lock_ok();
            g.push(2);
            panic!("holder dies mid-update");
        })
        .join();

        assert!(m.is_poisoned(), "precondition: the lock really is poisoned");
        assert_eq!(*m.lock_ok(), vec![1, 2]);

        let rw = Arc::new(RwLock::new(0_u8));
        let poisoner = Arc::clone(&rw);
        let _ = std::thread::spawn(move || {
            *poisoner.write_ok() = 7;
            panic!("writer dies");
        })
        .join();

        assert!(rw.is_poisoned());
        assert_eq!(*rw.read_ok(), 7);
        *rw.write_ok() = 8;
        assert_eq!(*rw.read_ok(), 8);
    }
}
