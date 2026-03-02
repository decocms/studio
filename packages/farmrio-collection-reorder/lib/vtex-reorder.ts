import type { FarmrioRankedItem } from "@decocms/bindings";

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

/**
 * Builds the VTEX apply payload from a ranked list.
 * Uses rankedItem.id as the SKU identifier (DB row id).
 * vtexCollectionId is the collection's DB id (used as VTEX collection id).
 */
export function buildVtexApplyPayload(
  rows: FarmrioRankedItem[],
  vtexCollectionId: number | string,
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
    const skuId = row.id != null ? String(row.id) : null;
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
    collectionId: String(vtexCollectionId),
    xml: buildVtexCollectionItemsXml(skuIds),
    skuCount: skuIds.length,
  };
}
