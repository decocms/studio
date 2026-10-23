import { GLOBALS_UPDATED, SET_GLOBALS } from "storybook/internal/core-events";
import { addons } from "storybook/manager-api";
import { create } from "storybook/theming";

const brand = {
  brandTitle: "deco · Design System",
  brandImage: "./brand/deco-logo.svg",
  brandUrl: "./?path=/docs/foundations-overview--docs",
  brandTarget: "_self",
  fontBase: '"Inter var", Inter, system-ui, sans-serif',
  fontCode: "ui-monospace, SFMono-Regular, Menlo, monospace",
  colorSecondary: "#07401a",
  appBorderRadius: 10,
  inputBorderRadius: 999,
} as const;

const light = create({
  ...brand,
  base: "light",
  colorPrimary: "#0a0a0a",
  appBg: "#f9f9f9",
  appContentBg: "#ffffff",
  appPreviewBg: "#ffffff",
  appBorderColor: "#ececec",
  textColor: "#0a0a0a",
  textMutedColor: "#666666",
  barBg: "#ffffff",
  barTextColor: "#666666",
  barSelectedColor: "#0a0a0a",
  barHoverColor: "#0a0a0a",
  inputBg: "#ffffff",
  inputBorder: "#ececec",
});

/* Hex approximations of the .dark tokens in global.css. */
const dark = create({
  ...brand,
  base: "dark",
  colorPrimary: "#f1f1f1",
  appBg: "#0b0b0b",
  appContentBg: "#0f0f0f",
  appPreviewBg: "#0f0f0f",
  appBorderColor: "#232323",
  textColor: "#f1f1f1",
  textMutedColor: "#8c8c8c",
  barBg: "#0f0f0f",
  barTextColor: "#8c8c8c",
  barSelectedColor: "#f1f1f1",
  barHoverColor: "#f1f1f1",
  inputBg: "#161616",
  inputBorder: "#232323",
});

addons.setConfig({
  showPanel: true,
  panelPosition: "bottom",
  sidebar: { showRoots: true },
  theme: light,
});

/* The manager follows the toolbar theme too; the class drives manager-head.html. */
addons.register("deco/theme-sync", (api) => {
  const apply = ({ globals }: { globals: Record<string, unknown> }) => {
    const isDark = globals.theme === "dark";
    document.documentElement.classList.toggle("dark", isDark);
    api.setOptions({ theme: isDark ? dark : light });
  };
  api.on(SET_GLOBALS, apply);
  api.on(GLOBALS_UPDATED, apply);
});
