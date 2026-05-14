/**
 * Board factories. The home starts empty; tiles appear as the user runs
 * the matching preset task from the side panel.
 */

import type { HomeBoard } from "./types";

export function createEmptyBoard(): HomeBoard {
  return { version: 3, tiles: [] };
}

export function createStarterBoard(): HomeBoard {
  return createEmptyBoard();
}
