import type { TerminalControllerOutputFrame } from "./terminal-controller";

const DEFAULT_CHUNK_BYTES = 16 * 1024;
const DEFAULT_MAX_QUEUED_BYTES = 4 * 1024 * 1024;

interface ScheduledFrame {
  frame: TerminalControllerOutputFrame;
  acknowledge: () => void;
}

interface ScheduledGroup {
  frames: ScheduledFrame[];
  data: Uint8Array;
  offset: number;
  started: boolean;
}

export interface TerminalOutputSchedulerSnapshot {
  queuedBytes: number;
  queuedGroups: number;
  peakQueuedBytes: number;
  writtenBytes: number;
  writeCount: number;
  overflowCount: number;
}

interface TerminalOutputSchedulerOptions {
  write: (data: Uint8Array, onParsed: () => void) => void;
  onFrameStart: (frame: TerminalControllerOutputFrame) => void;
  onFrameParsed?: (frame: TerminalControllerOutputFrame) => void;
  onWriteStateChange?: (writing: boolean) => void;
  onOverflow: () => void;
  chunkBytes?: number;
  maxQueuedBytes?: number;
  coalesce?: boolean;
  schedule?: (callback: () => void) => void;
}

function createDefaultScheduler(): {
  schedule: (callback: () => void) => void;
  dispose: () => void;
} {
  const channel = new MessageChannel();
  let pending: (() => void) | null = null;
  channel.port1.onmessage = () => {
    const callback = pending;
    pending = null;
    callback?.();
  };
  return {
    schedule: (callback) => {
      pending = callback;
      channel.port2.postMessage(undefined);
    },
    dispose: () => {
      pending = null;
      channel.port1.close();
      channel.port2.close();
    },
  };
}

function canCoalesce(
  group: ScheduledGroup,
  frame: TerminalControllerOutputFrame,
  chunkBytes: number,
): boolean {
  if (frame.kind !== "output" || group.frames.length === 0) return false;
  const previous = group.frames[group.frames.length - 1]?.frame;
  return (
    previous?.kind === "output" &&
    previous.allowCapabilityReplies === frame.allowCapabilityReplies &&
    previous.restorePendingCapabilityReplies ===
      frame.restorePendingCapabilityReplies &&
    previous.restoreUntilSeq === frame.restoreUntilSeq &&
    group.data.byteLength + frame.data.byteLength <= chunkBytes
  );
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

export class TerminalOutputScheduler {
  private readonly write: TerminalOutputSchedulerOptions["write"];
  private readonly onFrameStart: TerminalOutputSchedulerOptions["onFrameStart"];
  private readonly onFrameParsed: NonNullable<
    TerminalOutputSchedulerOptions["onFrameParsed"]
  >;
  private readonly onWriteStateChange: NonNullable<
    TerminalOutputSchedulerOptions["onWriteStateChange"]
  >;
  private readonly onOverflow: TerminalOutputSchedulerOptions["onOverflow"];
  private readonly chunkBytes: number;
  private readonly maxQueuedBytes: number;
  private readonly coalesce: boolean;
  private readonly schedule: NonNullable<
    TerminalOutputSchedulerOptions["schedule"]
  >;
  private readonly disposeSchedule: () => void;

  private groups: ScheduledGroup[] = [];
  private head = 0;
  private queuedBytes = 0;
  private peakQueuedBytes = 0;
  private writtenBytes = 0;
  private writeCount = 0;
  private overflowCount = 0;
  private drainScheduled = false;
  private writing = false;
  private disposed = false;

  constructor(options: TerminalOutputSchedulerOptions) {
    this.write = options.write;
    this.onFrameStart = options.onFrameStart;
    this.onFrameParsed = options.onFrameParsed ?? (() => {});
    this.onWriteStateChange = options.onWriteStateChange ?? (() => {});
    this.onOverflow = options.onOverflow;
    this.chunkBytes = Math.max(1, options.chunkBytes ?? DEFAULT_CHUNK_BYTES);
    this.maxQueuedBytes = Math.max(
      this.chunkBytes,
      options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES,
    );
    this.coalesce = options.coalesce ?? true;
    if (options.schedule) {
      this.schedule = options.schedule;
      this.disposeSchedule = () => {};
    } else {
      const scheduler = createDefaultScheduler();
      this.schedule = scheduler.schedule;
      this.disposeSchedule = scheduler.dispose;
    }
  }

  enqueue(frame: TerminalControllerOutputFrame, acknowledge: () => void): void {
    if (this.disposed) {
      acknowledge();
      return;
    }

    if (frame.kind === "reset") this.discardWaiting();

    if (this.queuedBytes + frame.data.byteLength > this.maxQueuedBytes) {
      acknowledge();
      this.overflowCount++;
      this.discardWaiting();
      this.onOverflow();
      return;
    }

    const tail = this.groups[this.groups.length - 1];
    if (
      tail &&
      this.coalesce &&
      !tail.started &&
      canCoalesce(tail, frame, this.chunkBytes)
    ) {
      tail.frames.push({ frame, acknowledge });
      tail.data = concatenate(tail.data, frame.data);
    } else {
      this.groups.push({
        frames: [{ frame, acknowledge }],
        data: frame.data,
        offset: 0,
        started: false,
      });
    }
    this.queuedBytes += frame.data.byteLength;
    this.peakQueuedBytes = Math.max(this.peakQueuedBytes, this.queuedBytes);
    this.requestDrain();
  }

  snapshot(): TerminalOutputSchedulerSnapshot {
    return {
      queuedBytes: this.queuedBytes,
      queuedGroups: this.groups.length - this.head,
      peakQueuedBytes: this.peakQueuedBytes,
      writtenBytes: this.writtenBytes,
      writeCount: this.writeCount,
      overflowCount: this.overflowCount,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeSchedule();
    this.discardPending();
  }

  private requestDrain(): void {
    if (
      this.disposed ||
      this.writing ||
      this.drainScheduled ||
      this.head >= this.groups.length
    ) {
      return;
    }
    this.drainScheduled = true;
    this.schedule(() => {
      this.drainScheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    if (this.disposed || this.writing) return;
    const group = this.groups[this.head];
    if (!group) return;

    if (!group.started) {
      group.started = true;
      for (const { frame } of group.frames) this.onFrameStart(frame);
    }

    if (group.offset >= group.data.byteLength) {
      this.completeGroup(group);
      this.requestDrain();
      return;
    }

    const end = Math.min(group.data.byteLength, group.offset + this.chunkBytes);
    const chunk = group.data.subarray(group.offset, end);
    this.writing = true;
    this.onWriteStateChange(true);
    try {
      this.write(chunk, () => {
        if (this.disposed) return;
        group.offset = end;
        this.queuedBytes = Math.max(0, this.queuedBytes - chunk.byteLength);
        this.writtenBytes += chunk.byteLength;
        this.writeCount++;
        this.writing = false;
        this.onWriteStateChange(false);
        if (group.offset >= group.data.byteLength) this.completeGroup(group);
        this.requestDrain();
      });
    } catch (error) {
      this.writing = false;
      this.onWriteStateChange(false);
      this.discardPending();
      throw error;
    }
  }

  private completeGroup(group: ScheduledGroup): void {
    for (const { frame, acknowledge } of group.frames) {
      acknowledge();
      this.onFrameParsed(frame);
    }
    this.head++;
    if (this.head >= 64 && this.head * 2 >= this.groups.length) {
      this.groups.splice(0, this.head);
      this.head = 0;
    }
  }

  private discardPending(): void {
    for (let index = this.head; index < this.groups.length; index++) {
      const group = this.groups[index];
      if (!group) continue;
      for (const { acknowledge } of group.frames) acknowledge();
    }
    this.groups = [];
    this.head = 0;
    this.queuedBytes = 0;
  }

  private discardWaiting(): void {
    if (!this.writing) {
      this.discardPending();
      return;
    }

    const active = this.groups[this.head];
    for (let index = this.head + 1; index < this.groups.length; index++) {
      const group = this.groups[index];
      if (!group) continue;
      for (const { acknowledge } of group.frames) acknowledge();
    }
    this.groups = active ? [active] : [];
    this.head = 0;
    this.queuedBytes = active
      ? Math.max(0, active.data.byteLength - active.offset)
      : 0;
  }
}
