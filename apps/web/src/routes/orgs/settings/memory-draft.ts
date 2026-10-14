import {
  entryMarker,
  type OrgFsConditionalWrite,
  type OrgFsEntry,
  type OrgFsWriteExpect,
} from "@/hooks/use-org-fs";

/** Quiet time after the last keystroke before the draft is written. */
const SAVE_DELAY_MS = 800;

export type SaveStatus =
  | "idle"
  | "dirty"
  | "saving"
  | "saved"
  | "conflict"
  | "forbidden"
  | "error";

/** A version of the file, and what a save over it must still find. */
export interface Version {
  marker: string;
  /** null for a file written before content hashes: saved unconditionally. */
  expect: OrgFsWriteExpect | null;
}

export const ABSENT: Version = { marker: "absent", expect: { absent: true } };

export function versionOf(entry: OrgFsEntry): Version {
  return {
    marker: entryMarker(entry),
    expect: entry.contentHash ? { contentHash: entry.contentHash } : null,
  };
}

/**
 * The unsaved draft of one file, kept outside React so a pending save outlives
 * the editor: debounced, one write at a time, each conditional on the version
 * the edit started from. A conflict or a refusal holds the draft until the
 * person decides.
 */
export class DraftSaver {
  private draft: string | null = null;
  private base: Version = ABSENT;
  /** Editor load the base came from; our own writes advance `base` without one. */
  private loaded = 0;
  private held = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue = Promise.resolve();

  constructor(
    private readonly write: (
      body: string,
      expect: OrgFsWriteExpect | null,
    ) => Promise<OrgFsConditionalWrite>,
    private readonly onStatus: (status: SaveStatus) => void,
    private readonly onSaved: (entry: OrgFsEntry, body: string) => void,
  ) {}

  /**
   * `from` is the version the editor was loaded with, as of the render that
   * handled the keystroke, so it can trail our own last write; only a newer
   * editor load replaces the base.
   */
  change(text: string, from: { version: Version; generation: number }) {
    if (this.draft === null && from.generation > this.loaded) {
      this.base = from.version;
      this.loaded = from.generation;
    }
    this.draft = text;
    if (this.held) return;
    this.onStatus("dirty");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }

  /** Write the draft now; `overwrite` skips the version check (Keep my version). */
  flush(overwrite = false) {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.held && !overwrite) return;
    this.held = false;
    this.queue = this.queue.then(() => this.save(overwrite));
  }

  discard() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.draft = null;
    this.held = false;
  }

  private async save(overwrite: boolean) {
    const body = this.draft;
    if (body === null) return;
    this.onStatus("saving");
    try {
      const res = await this.write(body, overwrite ? null : this.base.expect);
      if (!res.ok) {
        this.held = true;
        this.onStatus(res.reason);
        return;
      }
      this.base = versionOf(res.entry);
      this.onSaved(res.entry, body);
      if (this.draft === body) {
        this.draft = null;
        this.onStatus("saved");
      }
    } catch {
      this.onStatus("error");
    }
  }

  /** Mounted with the editor: warn before unloading a draft, save a pending one on unmount. */
  subscribe = () => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (this.draft !== null) e.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      if (this.timer !== undefined) this.flush();
    };
  };
}
