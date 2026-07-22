import type { chat as chatEn } from "../en/chat.ts";

export const chat = {
  "chat.mention.editPrompt": "Editar argumentos do prompt {name}",
} satisfies Record<keyof typeof chatEn, string>;
