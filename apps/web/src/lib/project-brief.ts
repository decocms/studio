/** The paragraph a workflow wrote about a project. Same seam as
 *  `projectReportConnectionId`: nothing writes `metadata.project.brief` yet,
 *  and `WhatMoved` states what provably moved until something does. */

/** `generatedAt` is required: a brief with no timestamp cannot be told from a
 *  three-week-old one presented as today's. */
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
