/** The deco report palette (scan screen, auth card). Fixed light: these
 *  surfaces are paper even when the app runs in dark mode. */
export const DECK = {
  bg: "#ffffff", // paper — crisp white
  ink: "#282524", // slate ink — never pure black
  muted: "#78726e", // gray text
  faint: "#a6a09d", // de-emphasized values
  border: "rgba(40,37,36,0.09)", // hairline between data rows
  surface: "#ffffff",
  primary: "#282524", // ink pill button bg
  primaryFg: "#ffffff",
  soft: "#8caa25", // almost-light green — accents/labels on white
  limeTint: "#eff6cc", // pale lime — delta/points pill bg
} as const;
