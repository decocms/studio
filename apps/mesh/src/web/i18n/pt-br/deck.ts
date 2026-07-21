import type { deck as deckEn } from "../en/deck.ts";

export const deck = {
  "deck.deckToolbar.agentRewriteWarning":
    "O agente reescreveu este deck enquanto voc\u00ea estava editando. Recarregar descarta as diferen\u00e7as n\u00e3o salvas.",
  "deck.deckToolbar.agentUpdatedReload": "Agente atualizado \u2014 recarregar",
  "deck.deckToolbar.doneEditing": "Terminar edi\u00e7\u00e3o",
  "deck.deckToolbar.download": "Baixar",
  "deck.deckToolbar.downloadHtml": "Baixar HTML",
  "deck.deckToolbar.editInline": "Editar em linha",
  "deck.deckToolbar.editInlineTooltip":
    "Editar em linha (texto, reordenar, deletar)",
  "deck.deckToolbar.exportAsPdf": "Exportar como PDF",
  "deck.deckToolbar.hideSlideList": "Ocultar lista de slides",
  "deck.deckToolbar.openInNewTab": "Abrir em nova aba",
  "deck.deckToolbar.saving": "Salvando\u2026",
  "deck.deckToolbar.showSlideList": "Mostrar lista de slides",
} satisfies Record<keyof typeof deckEn, string>;
