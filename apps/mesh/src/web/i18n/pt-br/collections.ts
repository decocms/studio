import type { collections as collectionsEn } from "../en/collections.ts";

export const collections = {
  "collections.collectionDisplayButton.displayAndFilters":
    "Exibi\u00e7\u00e3o & filtros",
  "collections.collectionDisplayButton.sortBy": "Ordenar por",
  "collections.collectionTableWrapper.loading": "Carregando...",
  "collections.collectionTableWrapper.noItemsFound": "Nenhum item encontrado",
} satisfies Record<keyof typeof collectionsEn, string>;
