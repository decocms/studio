import type { user as userEn } from "../en/user.ts";

export const user = {
  "user.user.unknownUser": "Usu\u00e1rio desconhecido",
} satisfies Record<keyof typeof userEn, string>;
