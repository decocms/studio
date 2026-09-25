/**
 * The paragraph a workflow wrote about a project, when one exists.
 *
 * The same seam shape as `projectReportConnectionId`: nothing writes
 * `metadata.project.brief` yet, it is read first on purpose, so the server side
 * of this can ship by writing it and nothing in the UI has to change. Until
 * then `WhatMoved` states the one thing that provably moved instead.
 *
 * Pure, and exported for its test.
 */

/**
 * The paragraph a workflow wrote about this project.
 *
 * `metadata.project.brief` is the pointer, and nothing writes it yet — it is
 * read first on purpose, so the server side of this can ship by writing it and
 * nothing in the UI has to change. `generatedAt` is required: a brief with no
 * timestamp cannot be told from a brief that is three weeks old, and a stale
 * one presented as today's is worse than none.
 */
export interface WrittenBrief {
  text: string;
  generatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readWrittenBrief(project: {
  metadata?: unknown;
}): WrittenBrief | null {
  const metadata = isRecord(project.metadata) ? project.metadata : {};
  const stored = isRecord(metadata.project) ? metadata.project : {};
  const brief = isRecord(stored.brief) ? stored.brief : null;
  if (!brief) return null;
  const text = typeof brief.text === "string" ? brief.text.trim() : "";
  const generatedAt =
    typeof brief.generatedAt === "string" ? brief.generatedAt : "";
  if (!text || !generatedAt || Number.isNaN(Date.parse(generatedAt))) {
    return null;
  }
  return { text, generatedAt };
}
