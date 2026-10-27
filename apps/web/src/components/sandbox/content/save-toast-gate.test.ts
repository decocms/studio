import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A hosted v8 save the reconcile flow ended by keeping the draft's copy
 * shows its own toast ("Kept their version" / "Left it deleted"); the
 * caller's success toast would be a second, untrue one. Every success toast
 * that follows a block save in these screens is gated on the save's result.
 */
const FILES = ["content-browser.tsx", "app-editor.tsx"];

/** Each `await saveBlock.mutateAsync(` whose result isn't kept, followed by a success toast before the next save or catch. */
function ungatedSuccessToasts(source: string): string[] {
  const found: string[] = [];
  const re = /(^|\n)([^\n]*)await saveBlock\.mutateAsync\(/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const line = m[2] ?? "";
    const rest = source.slice(m.index + m[0].length);
    const end = rest.search(/\bcatch\b|\.mutateAsync\(/);
    const window = end === -1 ? rest : rest.slice(0, end);
    if (!/toast\.success\(/.test(window)) continue;
    if (/=\s*$/.test(line.trim()) || /const \w+ =|\w+ = $/.test(line)) {
      // Kept: the toast must be gated on it.
      if (/keptTheirVersion\(/.test(window)) continue;
    }
    found.push(window.slice(0, window.indexOf("toast.success(") + 60).trim());
  }
  return found;
}

describe("success toasts after a block save", () => {
  for (const file of FILES) {
    test(`${file}: each one gives way to the kept-their-version toast`, () => {
      const source = readFileSync(join(import.meta.dir, file), "utf8");
      expect(ungatedSuccessToasts(source)).toEqual([]);
    });
  }
});
