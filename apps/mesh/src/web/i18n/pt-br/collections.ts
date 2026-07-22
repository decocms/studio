import type { collections as collectionsEn } from "../en/collections.ts";

export const collections = {
  "collections.collectionDisplayButton.displayAndFilters": "Exibição & filtros",
  "collections.collectionDisplayButton.sortBy": "Ordenar por",
  "collections.collectionTableWrapper.loading": "Carregando...",
  "collections.collectionTableWrapper.noItemsFound": "Nenhum item encontrado",
  "collections.mutations.itemCreatedSuccessfully": "Item criado com sucesso",
  "collections.mutations.itemUpdatedSuccessfully":
    "Item atualizado com sucesso",
  "collections.mutations.itemDeletedSuccessfully": "Item deletado com sucesso",
  "collections.mutations.createItemFailed": "Falha ao criar item: {error}",
  "collections.mutations.updateItemFailed": "Falha ao atualizar item: {error}",
  "collections.mutations.deleteItemFailed": "Falha ao deletar item: {error}",
} satisfies Record<keyof typeof collectionsEn, string>;
