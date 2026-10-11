/**
 * `/site-editor`'s one rule: while `deco serve` answers, the editor; while it
 * doesn't, the empty state a project's Localhost shows too
 * (`LocalServeEmptyState`), which keeps looking for it (backing off, paused
 * while the tab is hidden) and opens the editor as soon as it answers.
 */

import { type ReactNode, useState } from "react";
import { useDecoServeDiscovery } from "@/hooks/use-deco-serve-discovery";
import { usePreferences } from "@/hooks/use-preferences";
import type { ContentBackend } from "./content-backend";
import {
  type DecoServeConnection,
  endpointHost,
} from "./deco-serve-connection";
import {
  LocalServeEmptyState,
  type LocalServeWait,
} from "./local-serve-empty-state";

/** The editor's server stopped answering: back to the guide until it's back. */
export function isServeLost(backend: ContentBackend): boolean {
  return (
    backend.kind === "unavailable" &&
    backend.source === "local" &&
    (backend.problem?.reason ?? "not-answering") === "not-answering"
  );
}

const bare = (guide: ReactNode) => guide;

/**
 * The guide until one of `candidates` answers, then `editor`, until it calls
 * `onLost` (the server stopped answering), then the guide again.
 */
export function LocalServeSwitch({
  candidates,
  invalidLink = false,
  shell = bare,
  editor,
}: {
  candidates: readonly string[];
  /** The page was opened with a link that isn't a usable one. */
  invalidLink?: boolean;
  /** Frames the guide (the app shell). */
  shell?: (guide: ReactNode) => ReactNode;
  editor: (connection: DecoServeConnection, onLost: () => void) => ReactNode;
}) {
  const [connection, setConnection] = useState<DecoServeConnection | null>(
    null,
  );
  if (connection) return editor(connection, () => setConnection(null));
  return shell(
    <SiteEditorGuide
      candidates={candidates}
      invalidLink={invalidLink}
      onConnect={setConnection}
    />,
  );
}

export function SiteEditorGuide({
  candidates,
  invalidLink = false,
  onConnect,
}: {
  /** The endpoints looked for, in order (see `serveCandidates`). */
  candidates: readonly string[];
  /** The page was opened with a link that isn't a usable one. */
  invalidLink?: boolean;
  onConnect: (connection: DecoServeConnection) => void;
}) {
  const [{ language }] = usePreferences();
  const discovery = useDecoServeDiscovery({
    candidates,
    onFound: (endpoint) => onConnect({ endpoint }),
  });
  const { state, access, needsGesture } = discovery;
  const hosts = new Intl.ListFormat(language, {
    style: "long",
    type: "conjunction",
  }).format(candidates.map(endpointHost));

  // Same empty state, same states, as a project's Localhost.
  const wait: LocalServeWait =
    access === "denied"
      ? { kind: "denied" }
      : needsGesture
        ? { kind: "needs-gesture", onStart: discovery.start }
        : state.problem
          ? {
              kind: "problem",
              problem: state.problem,
              host: endpointHost(state.problem.endpoint),
            }
          : { kind: "looking", paused: state.status === "paused" };
  return (
    <LocalServeEmptyState wait={wait} hosts={hosts} invalidLink={invalidLink} />
  );
}
