/**
 * useDeckEditor — host side of the deck inline-editing loop.
 *
 * The deck preview iframe self-applies every edit optimistically and posts
 * the op here (see deck-messages.ts). This hook replays the op against a
 * cached copy of the deck's HTML source (deck-html-ops.ts), acks the
 * iframe, and debounce-saves the result to org-fs. Conflict policy is
 * last-writer-wins:
 *
 *  - While the user is editing (edit mode on, or a save pending/in
 *    flight), an agent rewrite does NOT reload the iframe — a toolbar
 *    badge offers an explicit reload, and the user's next save wins.
 *  - The hook's own saves are self-echo-suppressed: the PUT's returned
 *    entry marker is remembered so the stat refresh it triggers doesn't
 *    roll the iframe src.
 *  - Any inconsistency (stale op index, fetch/save failure) drops the
 *    cache and reloads the iframe from server truth.
 *
 * The iframe is sandboxed (opaque origin): identity is `event.source ===
 * iframe.contentWindow`, and messages post with targetOrigin "*".
 */

import { useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "@/sdk";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { KEYS } from "@/lib/query-keys";
import { entryMarker, useOrgFsWriteText } from "@/hooks/use-org-fs";
import {
  DECK_PROTOCOL_V,
  type DeckHostMessage,
  type DeckOpMessage,
  parseDeckRuntimeMessage,
} from "./deck-messages";
import { DeckOpError, applyDeckOp, countDeckSlides } from "./deck-html-ops";

const HOME_VOLUME = "home";
const STRUCTURAL_SAVE_DEBOUNCE_MS = 400;
const TEXT_SAVE_DEBOUNCE_MS = 800;

export interface DeckEditor {
  /** Ref callback for the preview iframe (attaches the message bridge). */
  iframeRef: (el: HTMLIFrameElement | null) => void;
  /** The framed document completed the deck-viewer handshake (posted
   *  `ready`) — gates the deck-specific toolbar controls. A plain HTML
   *  page never posts it and stays a passive preview. */
  deckDetected: boolean;
  /** Edits can be persisted (an org-fs save path was provided). */
  writable: boolean;
  /** Marker (`size-updatedAt`) the iframe src should be keyed by. Null
   *  until the file's stat has loaded once. */
  displayedMarker: string | null;
  editMode: boolean;
  setEditMode: (enabled: boolean) => void;
  /** Thumbnail-rail visibility inside the iframe (closed by default —
   *  presentation-first). Edit mode opens it runtime-side. */
  railOpen: boolean;
  setRailOpen: (open: boolean) => void;
  /** True while edits are being persisted. */
  saving: boolean;
  /** The agent rewrote the deck while the user was editing. */
  agentUpdated: boolean;
  /** Drop local state and reload the iframe at the latest server version. */
  reload: () => void;
  /** Post a host message into the iframe (print, goto). */
  postToIframe: (msg: DeckHostMessage) => void;
}

interface Machine {
  iframe: HTMLIFrameElement | null;
  source: string | null;
  queue: Promise<void>;
  saveTimer: ReturnType<typeof setTimeout> | null;
  selfMarkers: Set<string>;
}

export function useDeckEditor(args: {
  readUrl: string;
  /** Content marker the iframe src is keyed by (org-fs `size-updatedAt`,
   *  or the publish event's byte count for read-only sources). */
  statMarker: string | null;
  /** Org-fs home-volume path to persist edits to. Omit for read-only
   *  sources (e.g. the legacy pages/ pipeline) — ops are then refused. */
  savePath?: string;
}): DeckEditor {
  const writable = args.savePath !== undefined;
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const writeText = useOrgFsWriteText(HOME_VOLUME);

  const [editMode, setEditModeState] = useState(false);
  const [deckDetected, setDeckDetected] = useState(false);
  const [railOpen, setRailOpenState] = useState(false);
  const [agentUpdated, setAgentUpdated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savePending, setSavePending] = useState(false);
  const [displayedMarker, setDisplayedMarker] = useState<string | null>(null);
  const [seenMarker, setSeenMarker] = useState<string | null>(null);
  // Forces an iframe reload even when the server marker hasn't changed —
  // reload() after a failed op/save must resync the (diverged) iframe to
  // server truth, and the marker alone is an identical-state no-op then.
  const [reloadNonce, setReloadNonce] = useState(0);

  // Mutable op machinery — a stable plain object (lazy useState init, not
  // a ref, so no render-time .current access); mutated only from event
  // handlers/timers.
  const [machine] = useState<Machine>(() => ({
    iframe: null,
    source: null,
    queue: Promise.resolve(),
    saveTimer: null,
    selfMarkers: new Set(),
  }));

  const isEditing = editMode || savePending || saving;

  const invalidateStat = () => {
    if (args.savePath === undefined) return;
    queryClient.invalidateQueries({
      queryKey: KEYS.orgFsStat(org.id, HOME_VOLUME, args.savePath),
    });
    queryClient.invalidateQueries({ queryKey: KEYS.orgFsRecent(org.id) });
  };

  const postToIframe = (msg: DeckHostMessage) => {
    machine.iframe?.contentWindow?.postMessage(msg, "*");
  };

  const reload = () => {
    machine.source = null;
    setAgentUpdated(false);
    if (seenMarker) setDisplayedMarker(seenMarker);
    setReloadNonce((n) => n + 1);
    invalidateStat();
  };

  // ── Stat-marker reconciliation (derived state during render) ────────
  if (args.statMarker !== seenMarker) {
    setSeenMarker(args.statMarker);
    if (args.statMarker !== null) {
      if (displayedMarker === null) {
        // First stat — show the deck.
        setDisplayedMarker(args.statMarker);
      } else if (machine.selfMarkers.has(args.statMarker)) {
        // Our own save echoing back — the iframe already shows this
        // content (optimistic self-apply); don't reload it.
      } else if (args.statMarker !== displayedMarker) {
        if (isEditing) setAgentUpdated(true);
        else {
          machine.source = null;
          setDisplayedMarker(args.statMarker);
        }
      }
    }
  }

  // ── Saving ───────────────────────────────────────────────────────────
  const flushSave = async () => {
    machine.saveTimer = null;
    const body = machine.source;
    if (body === null) {
      setSavePending(false);
      return;
    }
    setSaving(true);
    try {
      const entry = await writeText.mutateAsync({
        path: args.savePath!,
        body,
      });
      machine.selfMarkers.add(entryMarker(entry));
      invalidateStat();
    } catch (err) {
      console.error("[deck-editor] save failed", err);
      toast.error("Couldn't save deck edits — reloading the preview.");
      // Same recovery as the op-failure path: the nonce in reload() forces
      // the iframe roll even though the failed PUT left the server marker
      // unchanged — otherwise the phantom edits would stay on screen.
      latestRef.current.reload();
    } finally {
      setSaving(false);
      setSavePending(false);
    }
  };

  const scheduleSave = (delayMs: number) => {
    setSavePending(true);
    if (machine.saveTimer) clearTimeout(machine.saveTimer);
    machine.saveTimer = setTimeout(() => {
      void latestRef.current.flushSave();
    }, delayMs);
  };

  // ── Op handling ──────────────────────────────────────────────────────
  const ack = (opId: string, ok: boolean, error?: string) => {
    postToIframe({ v: DECK_PROTOCOL_V, type: "ack", opId, ok, error });
  };

  const handleOp = async (msg: DeckOpMessage) => {
    if (!writable) {
      // Read-only source (no save path) — the edit affordances are hidden,
      // but refuse defensively in case the framed document emits anyway.
      ack(msg.opId, false, "read-only preview");
      return;
    }
    try {
      if (machine.source === null) {
        const res = await fetch(args.readUrl, { credentials: "include" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        machine.source = await res.text();
      }
      const count = countDeckSlides(machine.source);
      if (count === null || count !== msg.witness.childCount) {
        throw new DeckOpError(
          `slide count drifted (source ${count}, iframe ${msg.witness.childCount})`,
          "stale-index",
        );
      }
      machine.source = applyDeckOp(machine.source, msg.op);
      ack(msg.opId, true);
      scheduleSave(
        msg.op.kind === "replace"
          ? TEXT_SAVE_DEBOUNCE_MS
          : STRUCTURAL_SAVE_DEBOUNCE_MS,
      );
    } catch (err) {
      console.error("[deck-editor] op failed", msg.op, err);
      ack(msg.opId, false, err instanceof Error ? err.message : String(err));
      toast.error("That edit couldn't be saved — reloading the preview.");
      latestRef.current.reload();
    }
  };

  const onMessage = (e: MessageEvent) => {
    if (!machine.iframe || e.source !== machine.iframe.contentWindow) return;
    const msg = parseDeckRuntimeMessage(e.data);
    if (!msg) return;
    if (msg.type === "ready") {
      setDeckDetected(true);
      // Re-assert host-held view state after every (re)load of the
      // iframe document (the initial src hash only covers first paint).
      if (latestRef.current.editMode) {
        postToIframe({
          v: DECK_PROTOCOL_V,
          type: "set-edit-mode",
          enabled: true,
        });
      } else if (latestRef.current.railOpen) {
        postToIframe({ v: DECK_PROTOCOL_V, type: "set-rail", open: true });
      }
      return;
    }
    if (msg.type === "op") {
      machine.queue = machine.queue
        .then(() => latestRef.current.handleOp(msg))
        .catch(() => {});
    }
  };

  // Handlers close over per-render state; the stable window listener and
  // save timers delegate through this ref so they always see the latest.
  const latestRef = useRef({
    onMessage,
    handleOp,
    flushSave,
    reload,
    editMode,
    railOpen,
  });
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- latest-handler mirror, same pattern as chat-context's cbRef
  latestRef.current = {
    onMessage,
    handleOp,
    flushSave,
    reload,
    editMode,
    railOpen,
  };

  // Stable iframe ref callback: tracks the element and owns the window
  // message listener for its lifetime (no useEffect — see lint rules).
  const [iframeRef] = useState(() => {
    let detach: (() => void) | null = null;
    return (el: HTMLIFrameElement | null) => {
      if (el) {
        machine.iframe = el;
        const listener = (e: MessageEvent) => latestRef.current.onMessage(e);
        window.addEventListener("message", listener);
        detach = () => window.removeEventListener("message", listener);
      } else {
        detach?.();
        detach = null;
        machine.iframe = null;
      }
    };
  });

  const setRailOpen = (open: boolean) => {
    setRailOpenState(open);
    postToIframe({ v: DECK_PROTOCOL_V, type: "set-rail", open });
  };

  const setEditMode = (enabled: boolean) => {
    setEditModeState(enabled);
    postToIframe({ v: DECK_PROTOCOL_V, type: "set-edit-mode", enabled });
    // The runtime opens the rail when edit mode turns on (structural ops
    // live there) — mirror that so the toolbar toggle stays in sync.
    if (enabled) setRailOpenState(true);
    if (!enabled && agentUpdated && !savePending && !saving) {
      // Leaving edit mode with a pending agent update and nothing of ours
      // left to save — adopt the agent's version.
      reload();
    }
  };

  return {
    iframeRef,
    deckDetected,
    writable,
    displayedMarker:
      displayedMarker === null ? null : `${displayedMarker}.${reloadNonce}`,
    editMode,
    setEditMode,
    railOpen,
    setRailOpen,
    saving,
    agentUpdated,
    reload,
    postToIframe,
  };
}
