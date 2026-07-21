import type { user as userEn } from "../en/user.ts";

export const user = {
  "user.user.unknownUser": "Usuário desconhecido",
} satisfies Record<keyof typeof userEn, string>;
