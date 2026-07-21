import type { tools as toolsEn } from "../en/tools.ts";

export const tools = {
  "tools.toolsList.destructive": "Destrutivo",
  "tools.toolsList.idempotent": "Idempotente",
  "tools.toolsList.interactive": "Interativo",
  "tools.toolsList.openWorld": "Mundo aberto",
  "tools.toolsList.readOnly": "Somente leitura",
} satisfies Record<keyof typeof toolsEn, string>;
