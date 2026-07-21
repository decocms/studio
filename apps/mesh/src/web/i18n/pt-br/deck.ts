import type { deck as deckEn } from "../en/deck.ts";

export const deck = {
  "deck.deckToolbar.agentRewriteWarning":
    "O agente reescreveu este deck enquanto você estava editando. Recarregar descarta as diferenças não salvas.",
  "deck.deckToolbar.agentUpdatedReload": "Agente atualizado — recarregar",
  "deck.deckToolbar.doneEditing": "Terminar edição",
  "deck.deckToolbar.download": "Baixar",
  "deck.deckToolbar.downloadHtml": "Baixar HTML",
  "deck.deckToolbar.editInline": "Editar em linha",
  "deck.deckToolbar.editInlineTooltip":
    "Editar em linha (texto, reordenar, deletar)",
  "deck.deckToolbar.exportAsPdf": "Exportar como PDF",
  "deck.deckToolbar.hideSlideList": "Ocultar lista de slides",
  "deck.deckToolbar.openInNewTab": "Abrir em nova aba",
  "deck.deckToolbar.saving": "Salvando…",
  "deck.deckToolbar.showSlideList": "Mostrar lista de slides",
} satisfies Record<keyof typeof deckEn, string>;
