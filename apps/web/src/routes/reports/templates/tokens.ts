// Design tokens for the Signal Deck templates — the deco report design
// language, ported from the decocms landing. Kept in one place so every
// template shares the same palette and the deck reads as one system.

import type { Tone } from "@decocms/shared/reports/deck-types";

export type { Tone };

export const DECK = {
  bg: "#ffffff", // paper — crisp white
  ink: "#282524", // slate ink — never pure black
  muted: "#78726e", // gray text
  faint: "#a6a09d", // de-emphasized values ("de 100", struck-through)
  border: "rgba(40,37,36,0.09)", // hairline between data rows
  cardBorder: "rgba(40,37,36,0.06)", // card outer edge
  inputBorder: "rgba(40,37,36,0.18)", // control edges (buttons, inputs)
  surface: "#ffffff",
  primary: "#282524", // ink pill button bg
  primaryFg: "#ffffff",
  soft: "#8caa25", // almost-light green — accents/labels on white
  lime: "#d0ec1a", // light green surface; text on it is always forest
  limeTint: "#eff6cc", // pale lime — delta/points pill bg
  forest: "#07401a", // dark green — surfaces only, never text-on-white
  warn: "#f0b613", // attention yellow (meter fills, warning icons)
  notice: "#6e9fdb", // informational blue
} as const;

export const TONE_COLOR: Record<Tone, string> = {
  good: DECK.soft,
  bad: "#d43d3d", // report red — warmer than tailwind red
  neutral: DECK.ink,
};
