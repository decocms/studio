/**
 * Debounce window for form-driven block autosaves (ms). A v8 site
 * (`protocolProject`) waits at least 1 s per block, so a hosted draft file
 * takes about one write a second while typing (the design's rate for the
 * CDN's object store). A v7 site keeps 700 ms.
 */
export function autosaveDelay(protocolProject: boolean): number {
  return protocolProject ? 1000 : 700;
}
