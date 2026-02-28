import type { RankedListRow } from "@decocms/bindings";

export const HARDCODED_COLLECTION_ID = "REPLACE_WITH_COLLECTION_ID";

type NoteValue = string | number | null | undefined;

type RankedRowNote = {
  SkuId?: NoteValue;
  skuId?: NoteValue;
  sku_id?: NoteValue;
};

type ApplyPayloadError = {
  ok: false;
  error: string;
};

type ApplyPayloadSuccess = {
  ok: true;
  collectionId: string;
  xml: string;
  skuCount: number;
};

export type VtexApplyPayloadResult = ApplyPayloadSuccess | ApplyPayloadError;

function normalizeSkuId(value: NoteValue): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return null;
}

function readSkuIdFromNote(note: RankedListRow["note"]): string | null {
  if (!note || typeof note !== "object") {
    return null;
  }

  const rowNote = note as RankedRowNote;
  return (
    normalizeSkuId(rowNote.SkuId) ??
    normalizeSkuId(rowNote.skuId) ??
    normalizeSkuId(rowNote.sku_id)
  );
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildVtexCollectionItemsXml(skuIds: string[]): string {
  const itemBlocks = skuIds.map(
    (skuId) =>
      `  <CollectionItemDTO>\n    <SkuId>${escapeXml(skuId)}</SkuId>\n  </CollectionItemDTO>`,
  );

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<ArrayOfCollectionItemDTO>",
    ...itemBlocks,
    "</ArrayOfCollectionItemDTO>",
  ].join("\n");
}

export function buildVtexApplyPayload(
  rows: RankedListRow[],
): VtexApplyPayloadResult {
  if (rows.length === 0) {
    return {
      ok: false,
      error: "Nao ha itens na sugestao para aplicar.",
    };
  }

  const orderedRows = [...rows].sort((a, b) => a.position - b.position);
  const skuIds: string[] = [];

  for (const row of orderedRows) {
    const skuId = readSkuIdFromNote(row.note);
    if (!skuId) {
      return {
        ok: false,
        error: `SkuId ausente no item #${row.position} (${row.label}).`,
      };
    }
    skuIds.push(skuId);
  }

  return {
    ok: true,
    collectionId: HARDCODED_COLLECTION_ID,
    xml: buildVtexCollectionItemsXml(skuIds),
    skuCount: skuIds.length,
  };
}
