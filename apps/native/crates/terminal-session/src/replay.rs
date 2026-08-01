use std::collections::VecDeque;

use bytes::Bytes;

use crate::{OutputChunk, ReplaySnapshot};

/// Byte-bounded transcript tail. Offsets count every byte ever observed even
/// after old bytes are evicted, so clients can distinguish a clean reconnect
/// from an irrecoverable gap.
pub(crate) struct ReplayBuffer {
    capacity: usize,
    retained: usize,
    next_offset: u64,
    accepting: bool,
    chunks: VecDeque<OutputChunk>,
}

impl ReplayBuffer {
    pub(crate) fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            retained: 0,
            next_offset: 0,
            accepting: true,
            chunks: VecDeque::new(),
        }
    }

    pub(crate) fn append(&mut self, data: Bytes) -> Option<OutputChunk> {
        if !self.accepting || data.is_empty() {
            return None;
        }
        let start = self.next_offset;
        let byte_count = u64::try_from(data.len()).unwrap_or(u64::MAX);
        let end = start.saturating_add(byte_count);
        self.next_offset = end;
        let chunk = OutputChunk { start, end, data };
        self.retained = self.retained.saturating_add(chunk.data.len());
        self.chunks.push_back(chunk.clone());
        self.trim();
        Some(chunk)
    }

    pub(crate) fn stop_accepting(&mut self) {
        self.accepting = false;
    }

    pub(crate) fn bounds(&self) -> (u64, u64) {
        let available_from = self
            .chunks
            .front()
            .map_or(self.next_offset, |chunk| chunk.start);
        (available_from, self.next_offset)
    }

    pub(crate) fn snapshot_from(&self, requested_from: u64) -> ReplaySnapshot {
        let (available_from, next_offset) = self.bounds();
        let truncated = requested_from < available_from;
        let effective_from = requested_from.clamp(available_from, next_offset);
        let chunks = self
            .chunks
            .iter()
            .filter(|chunk| chunk.end > effective_from)
            .map(|chunk| {
                if chunk.start >= effective_from {
                    return chunk.clone();
                }
                let skip = usize::try_from(effective_from - chunk.start)
                    .unwrap_or(chunk.data.len())
                    .min(chunk.data.len());
                OutputChunk {
                    start: effective_from,
                    end: chunk.end,
                    data: chunk.data.slice(skip..),
                }
            })
            .collect();
        ReplaySnapshot {
            requested_from,
            available_from,
            next_offset,
            truncated,
            chunks,
        }
    }

    fn trim(&mut self) {
        while self.retained > self.capacity {
            let excess = self.retained - self.capacity;
            let Some(front) = self.chunks.front_mut() else {
                self.retained = 0;
                break;
            };
            if front.data.len() <= excess {
                let removed = self.chunks.pop_front().map_or(0, |chunk| chunk.data.len());
                self.retained = self.retained.saturating_sub(removed);
                continue;
            }

            front.start = front
                .start
                .saturating_add(u64::try_from(excess).unwrap_or(u64::MAX));
            front.data = front.data.slice(excess..);
            self.retained -= excess;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_through_a_chunk_without_losing_absolute_offsets() {
        let mut replay = ReplayBuffer::new(5);
        replay.append(Bytes::from_static(b"abcd"));
        replay.append(Bytes::from_static(b"efgh"));

        let snapshot = replay.snapshot_from(0);
        assert!(snapshot.truncated);
        assert_eq!(snapshot.available_from, 3);
        assert_eq!(snapshot.next_offset, 8);
        assert_eq!(snapshot.chunks[0].start, 3);
        assert_eq!(snapshot.chunks[0].data, Bytes::from_static(b"d"));
        assert_eq!(snapshot.chunks[1].data, Bytes::from_static(b"efgh"));
    }

    #[test]
    fn replay_slices_the_first_overlapping_chunk() {
        let mut replay = ReplayBuffer::new(20);
        replay.append(Bytes::from_static(b"abcd"));
        replay.append(Bytes::from_static(b"efgh"));

        let snapshot = replay.snapshot_from(6);
        assert!(!snapshot.truncated);
        assert_eq!(snapshot.chunks.len(), 1);
        assert_eq!(snapshot.chunks[0].start, 6);
        assert_eq!(snapshot.chunks[0].end, 8);
        assert_eq!(snapshot.chunks[0].data, Bytes::from_static(b"gh"));
    }

    #[test]
    fn a_request_ahead_of_output_clamps_to_the_live_tail() {
        let mut replay = ReplayBuffer::new(20);
        replay.append(Bytes::from_static(b"abcd"));

        let snapshot = replay.snapshot_from(99);
        assert!(!snapshot.truncated);
        assert_eq!(snapshot.next_offset, 4);
        assert!(snapshot.chunks.is_empty());
    }

    #[test]
    fn stopped_buffer_rejects_late_reader_bytes() {
        let mut replay = ReplayBuffer::new(20);
        replay.append(Bytes::from_static(b"before"));
        replay.stop_accepting();
        assert!(replay.append(Bytes::from_static(b"after")).is_none());
        assert_eq!(replay.snapshot_from(0).next_offset, 6);
    }
}
