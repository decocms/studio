/**
 * MessageProducedFiles — file rows under the assistant message that
 * PRODUCED them (replacing the old thread-aggregate "files shared in this
 * chat" block that always sat under the last message).
 *
 * Attribution is client-side: the message's own tool parts name the files
 * it produced — `share_with_user` returns `{ filename }`, and `write`
 * calls targeting the org-output mount carry the path in their input.
 * Those names are matched against the thread-outputs listing (shared
 * `useThreadOutputs` query) to get key/size/downloadUrl. Files produced
 * invisibly (e.g. `bash` cp into org/output) can't be attributed to a
 * turn and surface only in ThreadFilesPanel.
 *
 * Caveat: the match is by filename, so a file re-written in a later turn
 * shows on every producing turn (it IS the same output). Encoding the
 * message id in the storage key is the future per-turn-exact fix.
 */

import { useThreadOutputs } from "../use-thread-outputs.ts";
import { OutputFileRow } from "../output-file-row.tsx";

interface MessageLike {
  parts?: ReadonlyArray<unknown>;
}

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

/** Matches sandbox paths under the org-output mount: `output/x`,
 *  `org/output/x`, `/app/org/output/x`. */
const OUTPUT_PATH_RE = /(^|\/)output\//;

function collectProducedFilenames(message: MessageLike): Set<string> {
  const names = new Set<string>();
  for (const raw of message.parts ?? []) {
    const part = raw as {
      type?: string;
      state?: string;
      input?: { path?: string; source?: string; name?: string };
      output?: { filename?: string };
    };
    if (part.state !== "output-available") continue;
    if (part.type === "tool-share_with_user") {
      const name =
        part.output?.filename ??
        part.input?.name ??
        (part.input?.source ? basename(part.input.source) : null);
      if (name) names.add(name);
    } else if (part.type === "tool-write") {
      const path = part.input?.path;
      if (path && OUTPUT_PATH_RE.test(path)) names.add(basename(path));
    }
  }
  return names;
}

export function MessageProducedFiles({
  threadId,
  message,
}: {
  threadId: string;
  message: MessageLike;
}) {
  const produced = collectProducedFilenames(message);
  const { data: outputs } = useThreadOutputs(threadId, {
    enabled: produced.size > 0,
  });

  if (produced.size === 0) return null;
  const files = (outputs ?? []).filter((o) => produced.has(o.filename));
  if (files.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5 py-2">
      {files.map((file) => (
        <OutputFileRow key={file.key} file={file} />
      ))}
    </div>
  );
}
