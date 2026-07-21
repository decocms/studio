import type { layouts as layoutsEn } from "../en/layouts.ts";

export const layouts = {
  "layouts.shellControls.navigationTitle": "Navegação",
  "layouts.shellControls.toggleSidebar": "Alternar barra lateral",
} satisfies Record<keyof typeof layoutsEn, string>;
