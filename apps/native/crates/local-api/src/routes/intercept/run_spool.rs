//! Disk-backed, bounded replay for one native Decopilot SSE run.
//!
//! A [`RunSpool`] deliberately keeps no replay `Vec` in memory. Complete SSE
//! frames are appended to one per-run file and flushed before they enter the
//! bounded live broadcast channel. A late subscriber atomically takes a file
//! snapshot and subscribes to future frames under the same mutex used by
//! [`RunSpool::append`], so a frame can never fall into a snapshot/subscribe
//! gap (or appear in both halves of that handoff).
//!
//! Unlike the terminal [`crate::log_store::LogStore`], this store must never
//! rotate: removing the beginning of an SSE transcript can leave a reconnect
//! without its protocol prefix. Crossing the hard cap therefore returns
//! [`RunSpoolError::CapacityExceeded`] before either the file or live channel
//! changes. The caller can then cancel the harness and emit/record a bounded
//! terminal failure through its normal control path.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use bytes::Bytes;
use thiserror::Error;
use tokio::fs::{self, File, OpenOptions};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufWriter};
use tokio::sync::{broadcast, Mutex};

/// Maximum retained bytes for one run. The limit is intentionally hard: a
/// frame that would cross it is rejected whole, never rotated or truncated.
pub(crate) const DEFAULT_RUN_SPOOL_CAP_BYTES: u64 = 10 * 1024 * 1024;

/// Only live fan-out occupies retained RAM. This is bounded independently of
/// the disk cap; a slow reader receives an explicit lag error and must reconnect
/// for a fresh atomic replay instead of silently skipping frames.
const DEFAULT_LIVE_CHANNEL_CAPACITY: usize = 1024;

#[derive(Debug, Error)]
pub(crate) enum RunSpoolError {
    #[error("run spool at {path:?} is finished")]
    Finished { path: PathBuf },

    #[error("run spool at {path:?} was removed")]
    Removed { path: PathBuf },

    #[error("run spool at {path:?} already has a staged frame")]
    StagedFramePending { path: PathBuf },

    #[error("run spool staged-frame token does not match at {path:?}")]
    StagedFrameMismatch { path: PathBuf },

    #[error(
        "run spool capacity exceeded at {path:?}: {current_bytes} retained + \
         {frame_bytes} frame bytes exceeds {cap_bytes} byte cap"
    )]
    CapacityExceeded {
        path: PathBuf,
        cap_bytes: u64,
        current_bytes: u64,
        frame_bytes: usize,
    },

    #[error("run spool file already exceeds its cap at {path:?}: {current_bytes} > {cap_bytes}")]
    ExistingFileExceedsCapacity {
        path: PathBuf,
        cap_bytes: u64,
        current_bytes: u64,
    },

    #[error("run spool {operation} failed at {path:?}: {source}")]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// A live subscriber falling behind is a recoverable protocol event, not
/// permission to discard bytes. The subscription is invalidated after this
/// error; reconnecting through [`RunSpool::subscribe`] produces a new complete
/// disk replay followed by a fresh live receiver.
#[derive(Debug, Error, PartialEq, Eq)]
pub(crate) enum RunSpoolRecvError {
    #[error("run spool live subscriber lagged by {skipped} frame(s); reconnect for replay")]
    Lagged { skipped: u64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Active,
    Finished,
    Removed,
}

struct Inner {
    writer: Option<BufWriter<File>>,
    /// Physical bytes flushed to the file, including a staged terminal frame.
    written: u64,
    /// Prefix safe for replay. Equal to `written` except while a terminal frame
    /// is staged across the SQLite finalization transaction.
    visible: u64,
    staged: Option<PendingFrame>,
    sender: Option<broadcast::Sender<Bytes>>,
    state: State,
}

struct PendingFrame {
    start: u64,
    frame: Bytes,
}

/// Ownership token for one flushed-but-not-yet-visible terminal frame.
pub(crate) struct StagedFrame {
    start: u64,
    end: u64,
}

/// One file-backed SSE transcript and its transient live fan-out.
pub(crate) struct RunSpool {
    path: PathBuf,
    cap_bytes: u64,
    inner: Mutex<Inner>,
}

impl RunSpool {
    /// Opens (or creates) a per-run spool at `path` with the production cap.
    /// Existing bytes are retained and become replayable, which lets a caller
    /// reconstruct a run registry after a process restart.
    pub(crate) async fn open(path: PathBuf) -> Result<Arc<Self>, RunSpoolError> {
        Self::open_with_limits(
            path,
            DEFAULT_RUN_SPOOL_CAP_BYTES,
            DEFAULT_LIVE_CHANNEL_CAPACITY,
        )
        .await
    }

    #[cfg(test)]
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    #[cfg(test)]
    pub(crate) async fn open_with_cap(
        path: PathBuf,
        cap_bytes: u64,
    ) -> Result<Arc<Self>, RunSpoolError> {
        Self::open_with_limits(path, cap_bytes, DEFAULT_LIVE_CHANNEL_CAPACITY).await
    }

    #[cfg(test)]
    pub(crate) async fn open_with_test_limits(
        path: PathBuf,
        cap_bytes: u64,
        live_capacity: usize,
    ) -> Result<Arc<Self>, RunSpoolError> {
        Self::open_with_limits(path, cap_bytes, live_capacity).await
    }

    async fn open_with_limits(
        path: PathBuf,
        cap_bytes: u64,
        live_capacity: usize,
    ) -> Result<Arc<Self>, RunSpoolError> {
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent)
                .await
                .map_err(|source| Self::io("create parent directory", &path, source))?;
        }

        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
            .map_err(|source| Self::io("open", &path, source))?;
        crate::fs_util::set_owner_only_async(&path)
            .await
            .map_err(|source| Self::io("set private permissions", &path, source))?;
        let written = file
            .metadata()
            .await
            .map_err(|source| Self::io("read metadata", &path, source))?
            .len();
        if written > cap_bytes {
            return Err(RunSpoolError::ExistingFileExceedsCapacity {
                path,
                cap_bytes,
                current_bytes: written,
            });
        }

        // `tokio::sync::broadcast::channel(0)` panics. Tests inject a small
        // positive capacity to exercise lag; production always uses 1024.
        let (sender, _receiver) = broadcast::channel(live_capacity.max(1));
        Ok(Arc::new(Self {
            path,
            cap_bytes,
            inner: Mutex::new(Inner {
                writer: Some(BufWriter::new(file)),
                written,
                visible: written,
                staged: None,
                sender: Some(sender),
                state: State::Active,
            }),
        }))
    }

    /// Durably appends one complete SSE frame, then fans it out live.
    ///
    /// The file flush and broadcast happen while holding the same mutex used by
    /// [`Self::subscribe`]. Therefore a subscriber observes the frame either in
    /// its replay prefix or from its live receiver, exactly once at the handoff.
    pub(crate) async fn append(&self, frame: Bytes) -> Result<(), RunSpoolError> {
        // An empty body carries no SSE event and cannot be represented in a
        // later byte replay. Treat it consistently as a no-op rather than
        // delivering a live-only phantom frame.
        if frame.is_empty() {
            return Ok(());
        }
        let mut inner = self.inner.lock().await;
        match inner.state {
            State::Finished => {
                return Err(RunSpoolError::Finished {
                    path: self.path.clone(),
                });
            }
            State::Removed => {
                return Err(RunSpoolError::Removed {
                    path: self.path.clone(),
                });
            }
            State::Active => {}
        }
        if inner.staged.is_some() {
            return Err(RunSpoolError::StagedFramePending {
                path: self.path.clone(),
            });
        }

        let next_len = inner
            .written
            .checked_add(frame.len() as u64)
            .filter(|next| *next <= self.cap_bytes)
            .ok_or_else(|| RunSpoolError::CapacityExceeded {
                path: self.path.clone(),
                cap_bytes: self.cap_bytes,
                current_bytes: inner.written,
                frame_bytes: frame.len(),
            })?;

        let writer = inner
            .writer
            .as_mut()
            .expect("an active run spool always owns its writer");
        writer
            .write_all(&frame)
            .await
            .map_err(|source| Self::io("append", &self.path, source))?;
        writer
            .flush()
            .await
            .map_err(|source| Self::io("flush", &self.path, source))?;
        inner.written = next_len;
        inner.visible = next_len;

        if let Some(sender) = &inner.sender {
            // No receiver is ordinary: the durable file is the late-reader
            // path. A lagged receiver is reported by `RunSubscription::recv`.
            let _ = sender.send(frame);
        }
        Ok(())
    }

    /// Flushes a terminal frame without making it replayable or live yet. The
    /// caller commits its SQLite terminal transaction, then calls
    /// [`Self::commit_staged`]. If that transaction fails it must call
    /// [`Self::rollback_staged`]. Only one frame may be staged at a time.
    pub(crate) async fn stage(&self, frame: Bytes) -> Result<StagedFrame, RunSpoolError> {
        let mut inner = self.inner.lock().await;
        match inner.state {
            State::Finished => {
                return Err(RunSpoolError::Finished {
                    path: self.path.clone(),
                });
            }
            State::Removed => {
                return Err(RunSpoolError::Removed {
                    path: self.path.clone(),
                });
            }
            State::Active => {}
        }
        if inner.staged.is_some() {
            return Err(RunSpoolError::StagedFramePending {
                path: self.path.clone(),
            });
        }
        let start = inner.written;
        let end = start
            .checked_add(frame.len() as u64)
            .filter(|next| *next <= self.cap_bytes)
            .ok_or_else(|| RunSpoolError::CapacityExceeded {
                path: self.path.clone(),
                cap_bytes: self.cap_bytes,
                current_bytes: inner.written,
                frame_bytes: frame.len(),
            })?;
        let writer = inner
            .writer
            .as_mut()
            .expect("an active run spool always owns its writer");
        writer
            .write_all(&frame)
            .await
            .map_err(|source| Self::io("stage", &self.path, source))?;
        writer
            .flush()
            .await
            .map_err(|source| Self::io("stage flush", &self.path, source))?;
        inner.written = end;
        inner.staged = Some(PendingFrame { start, frame });
        Ok(StagedFrame { start, end })
    }

    /// Makes a previously flushed terminal frame atomically visible to replay
    /// and live subscribers. No filesystem I/O remains at this point, so once
    /// the SQLite terminal transaction commits this step cannot fail for disk
    /// or capacity reasons.
    pub(crate) async fn commit_staged(&self, staged: StagedFrame) -> Result<(), RunSpoolError> {
        let mut inner = self.inner.lock().await;
        let matches = inner
            .staged
            .as_ref()
            .is_some_and(|pending| pending.start == staged.start && inner.written == staged.end);
        if !matches {
            return Err(RunSpoolError::StagedFrameMismatch {
                path: self.path.clone(),
            });
        }
        let pending = inner.staged.take().expect("staged frame checked above");
        inner.visible = inner.written;
        if let Some(sender) = &inner.sender {
            let _ = sender.send(pending.frame);
        }
        Ok(())
    }

    /// Discards a staged frame after SQLite terminal finalization failed. The
    /// visible replay prefix never included these bytes.
    pub(crate) async fn rollback_staged(&self, staged: StagedFrame) -> Result<(), RunSpoolError> {
        let mut inner = self.inner.lock().await;
        let matches = inner
            .staged
            .as_ref()
            .is_some_and(|pending| pending.start == staged.start && inner.written == staged.end);
        if !matches {
            return Err(RunSpoolError::StagedFrameMismatch {
                path: self.path.clone(),
            });
        }
        let writer = inner
            .writer
            .as_mut()
            .expect("an active run spool always owns its writer");
        writer
            .flush()
            .await
            .map_err(|source| Self::io("rollback flush", &self.path, source))?;
        writer
            .get_ref()
            .set_len(staged.start)
            .await
            .map_err(|source| Self::io("rollback truncate", &self.path, source))?;
        inner.written = staged.start;
        inner.visible = staged.start;
        inner.staged = None;
        Ok(())
    }

    /// Atomically captures every retained byte and subscribes to future frames.
    /// The returned replay is transient request memory, not retained run state.
    pub(crate) async fn subscribe(&self) -> Result<RunSubscription, RunSpoolError> {
        let inner = self.inner.lock().await;
        if inner.state == State::Removed {
            return Err(RunSpoolError::Removed {
                path: self.path.clone(),
            });
        }

        // Subscribe BEFORE reading, while append is excluded by this mutex.
        // Once the mutex is released every subsequent append is live-only;
        // everything before it is bounded by `written` and read below.
        let receiver = inner.sender.as_ref().map(|sender| sender.subscribe());
        let replay_len = usize::try_from(inner.visible).map_err(|source| {
            Self::io(
                "size replay buffer",
                &self.path,
                std::io::Error::new(ErrorKind::InvalidData, source),
            )
        })?;
        let mut replay = vec![0; replay_len];
        if replay_len > 0 {
            let mut reader = File::open(&self.path)
                .await
                .map_err(|source| Self::io("open replay", &self.path, source))?;
            reader
                .read_exact(&mut replay)
                .await
                .map_err(|source| Self::io("read replay", &self.path, source))?;
        }

        Ok(RunSubscription {
            replay: Bytes::from(replay),
            receiver,
        })
    }

    /// Ends live delivery after already-buffered receiver frames drain. The
    /// file remains available for late replay until [`Self::remove`] is called.
    pub(crate) async fn finish(&self) -> Result<(), RunSpoolError> {
        let mut inner = self.inner.lock().await;
        match inner.state {
            State::Removed => {
                return Err(RunSpoolError::Removed {
                    path: self.path.clone(),
                });
            }
            State::Finished => return Ok(()),
            State::Active => {}
        }
        if inner.staged.is_some() {
            return Err(RunSpoolError::StagedFramePending {
                path: self.path.clone(),
            });
        }
        if let Some(writer) = inner.writer.as_mut() {
            writer
                .flush()
                .await
                .map_err(|source| Self::io("finish flush", &self.path, source))?;
        }
        inner.sender.take();
        inner.state = State::Finished;
        Ok(())
    }

    /// Closes the writer and asynchronously deletes the retained transcript.
    /// Idempotent after a successful removal.
    pub(crate) async fn remove(&self) -> Result<(), RunSpoolError> {
        let mut inner = self.inner.lock().await;
        if inner.state == State::Removed {
            return Ok(());
        }
        if let Some(mut writer) = inner.writer.take() {
            writer
                .flush()
                .await
                .map_err(|source| Self::io("cleanup flush", &self.path, source))?;
        }
        inner.sender.take();
        inner.state = State::Finished;
        match fs::remove_file(&self.path).await {
            Ok(()) => {}
            Err(source) if source.kind() == ErrorKind::NotFound => {}
            Err(source) => return Err(Self::io("remove", &self.path, source)),
        }
        inner.state = State::Removed;
        inner.written = 0;
        inner.visible = 0;
        inner.staged = None;
        Ok(())
    }

    fn io(operation: &'static str, path: &Path, source: std::io::Error) -> RunSpoolError {
        RunSpoolError::Io {
            operation,
            path: path.to_path_buf(),
            source,
        }
    }
}

/// Atomic replay prefix plus the live continuation for one connection.
pub(crate) struct RunSubscription {
    replay: Bytes,
    receiver: Option<broadcast::Receiver<Bytes>>,
}

impl RunSubscription {
    pub(crate) fn take_replay(&mut self) -> Bytes {
        std::mem::take(&mut self.replay)
    }

    /// Receives the next live frame. `Ok(None)` means the producer finished.
    /// A lag error invalidates this subscription so consumers cannot
    /// accidentally continue after silently losing frames.
    pub(crate) async fn recv(&mut self) -> Result<Option<Bytes>, RunSpoolRecvError> {
        let Some(receiver) = self.receiver.as_mut() else {
            return Ok(None);
        };
        match receiver.recv().await {
            Ok(frame) => Ok(Some(frame)),
            Err(broadcast::error::RecvError::Closed) => {
                self.receiver = None;
                Ok(None)
            }
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                self.receiver = None;
                Err(RunSpoolRecvError::Lagged { skipped })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::Barrier;

    async fn spool(dir: &tempfile::TempDir, cap: u64, live_capacity: usize) -> Arc<RunSpool> {
        RunSpool::open_with_limits(dir.path().join("run.sse"), cap, live_capacity)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn late_subscriber_replays_the_complete_finished_transcript() {
        let dir = tempfile::tempdir().unwrap();
        let spool = spool(&dir, DEFAULT_RUN_SPOOL_CAP_BYTES, 8).await;
        spool
            .append(Bytes::from_static(b"event: message\ndata: one\n\n"))
            .await
            .unwrap();
        spool
            .append(Bytes::from_static(b"event: message\ndata: two\n\n"))
            .await
            .unwrap();
        spool.finish().await.unwrap();

        let mut subscription = spool.subscribe().await.unwrap();
        assert_eq!(
            subscription.take_replay(),
            Bytes::from_static(b"event: message\ndata: one\n\nevent: message\ndata: two\n\n")
        );
        assert_eq!(subscription.recv().await.unwrap(), None);
    }

    #[tokio::test]
    async fn concurrent_snapshot_boundary_has_no_loss_or_duplication() {
        // Exercise both legal mutex orderings repeatedly: if append wins, B is
        // in replay; if subscribe wins, B is live. It must never be in neither
        // or both.
        for iteration in 0..64 {
            let dir = tempfile::tempdir().unwrap();
            let spool = spool(&dir, DEFAULT_RUN_SPOOL_CAP_BYTES, 8).await;
            spool.append(Bytes::from_static(b"A")).await.unwrap();
            let barrier = Arc::new(Barrier::new(3));

            let subscribe_spool = spool.clone();
            let subscribe_barrier = barrier.clone();
            let subscribe = tokio::spawn(async move {
                subscribe_barrier.wait().await;
                subscribe_spool.subscribe().await.unwrap()
            });
            let append_spool = spool.clone();
            let append_barrier = barrier.clone();
            let append = tokio::spawn(async move {
                append_barrier.wait().await;
                append_spool.append(Bytes::from_static(b"B")).await.unwrap();
            });

            barrier.wait().await;
            let (subscription, append) = tokio::join!(subscribe, append);
            let mut subscription = subscription.unwrap();
            append.unwrap();
            spool.finish().await.unwrap();

            let mut observed = subscription.take_replay().to_vec();
            while let Some(frame) = subscription.recv().await.unwrap() {
                observed.extend_from_slice(&frame);
            }
            assert_eq!(observed, b"AB", "failed at iteration {iteration}");
        }
    }

    #[tokio::test]
    async fn cap_rejects_the_whole_frame_without_changing_replay_or_live() {
        let dir = tempfile::tempdir().unwrap();
        let spool = spool(&dir, 4, 8).await;
        let mut subscription = spool.subscribe().await.unwrap();
        spool.append(Bytes::from_static(b"1234")).await.unwrap();
        let error = spool.append(Bytes::from_static(b"5")).await.unwrap_err();
        assert!(matches!(
            error,
            RunSpoolError::CapacityExceeded {
                cap_bytes: 4,
                current_bytes: 4,
                frame_bytes: 1,
                ..
            }
        ));
        spool.finish().await.unwrap();

        assert_eq!(subscription.take_replay(), Bytes::new());
        assert_eq!(
            subscription.recv().await.unwrap(),
            Some(Bytes::from_static(b"1234"))
        );
        assert_eq!(subscription.recv().await.unwrap(), None);
        let mut late = spool.subscribe().await.unwrap();
        assert_eq!(late.take_replay(), Bytes::from_static(b"1234"));
        assert_eq!(late.recv().await.unwrap(), None);
    }

    #[tokio::test]
    async fn live_delivery_only_happens_after_the_frame_is_flushed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("run.sse");
        let spool = RunSpool::open_with_limits(path.clone(), 1024, 8)
            .await
            .unwrap();
        let mut subscription = spool.subscribe().await.unwrap();
        spool.append(Bytes::from_static(b"durable")).await.unwrap();
        assert_eq!(
            subscription.recv().await.unwrap(),
            Some(Bytes::from_static(b"durable"))
        );
        assert_eq!(fs::read(path).await.unwrap(), b"durable");
    }

    #[tokio::test]
    async fn staged_terminal_is_hidden_until_commit_then_replayable_and_live() {
        let dir = tempfile::tempdir().unwrap();
        let spool = spool(&dir, 1024, 8).await;
        spool.append(Bytes::from_static(b"prefix")).await.unwrap();

        let staged = spool.stage(Bytes::from_static(b"terminal")).await.unwrap();
        let mut during = spool.subscribe().await.unwrap();
        assert_eq!(during.take_replay(), Bytes::from_static(b"prefix"));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), during.recv())
                .await
                .is_err()
        );

        spool.commit_staged(staged).await.unwrap();
        assert_eq!(
            during.recv().await.unwrap(),
            Some(Bytes::from_static(b"terminal"))
        );
        spool.finish().await.unwrap();

        let mut late = spool.subscribe().await.unwrap();
        assert_eq!(late.take_replay(), Bytes::from_static(b"prefixterminal"));
        assert_eq!(late.recv().await.unwrap(), None);
    }

    #[tokio::test]
    async fn rollback_discards_hidden_terminal_and_allows_a_new_append() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("run.sse");
        let spool = RunSpool::open_with_limits(path.clone(), 1024, 8)
            .await
            .unwrap();
        spool.append(Bytes::from_static(b"prefix")).await.unwrap();

        let staged = spool.stage(Bytes::from_static(b"discarded")).await.unwrap();
        spool.rollback_staged(staged).await.unwrap();
        spool
            .append(Bytes::from_static(b"replacement"))
            .await
            .unwrap();
        spool.finish().await.unwrap();

        assert_eq!(fs::read(path).await.unwrap(), b"prefixreplacement");
        let mut late = spool.subscribe().await.unwrap();
        assert_eq!(late.take_replay(), Bytes::from_static(b"prefixreplacement"));
        assert_eq!(late.recv().await.unwrap(), None);
    }

    #[tokio::test]
    async fn cleanup_removes_the_file_and_blocks_future_use() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/run.sse");
        let spool = RunSpool::open_with_limits(path.clone(), 1024, 8)
            .await
            .unwrap();
        spool.append(Bytes::from_static(b"frame")).await.unwrap();

        spool.remove().await.unwrap();
        assert_eq!(
            fs::metadata(&path).await.unwrap_err().kind(),
            ErrorKind::NotFound
        );
        assert!(matches!(
            spool.append(Bytes::from_static(b"late")).await,
            Err(RunSpoolError::Removed { .. })
        ));
        assert!(matches!(
            spool.subscribe().await,
            Err(RunSpoolError::Removed { .. })
        ));
        spool.remove().await.unwrap();
    }

    #[tokio::test]
    async fn broadcast_lag_is_explicit_and_invalidates_the_subscription() {
        let dir = tempfile::tempdir().unwrap();
        let spool = spool(&dir, 1024, 1).await;
        let mut subscription = spool.subscribe().await.unwrap();
        spool.append(Bytes::from_static(b"one")).await.unwrap();
        spool.append(Bytes::from_static(b"two")).await.unwrap();

        assert_eq!(
            subscription.recv().await.unwrap_err(),
            RunSpoolRecvError::Lagged { skipped: 1 }
        );
        assert_eq!(subscription.recv().await.unwrap(), None);

        let mut reconnected = spool.subscribe().await.unwrap();
        assert_eq!(reconnected.take_replay(), Bytes::from_static(b"onetwo"));
    }

    #[tokio::test]
    async fn reopening_preserves_a_previous_process_transcript() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("run.sse");
        let first = RunSpool::open_with_limits(path.clone(), 1024, 8)
            .await
            .unwrap();
        first
            .append(Bytes::from_static(b"persisted"))
            .await
            .unwrap();
        first.finish().await.unwrap();
        drop(first);

        let reopened = RunSpool::open_with_limits(path, 1024, 8).await.unwrap();
        let mut subscription = reopened.subscribe().await.unwrap();
        assert_eq!(subscription.take_replay(), Bytes::from_static(b"persisted"));
    }
}
