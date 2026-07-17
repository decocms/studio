import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createReportPagesRoutes } from "./report-pages";

const INDEX_HTML = `<!doctype html>
<html>
  <head>
    <title>decocms</title>
    <meta name="description" content="default" />
  </head>
  <body></body>
</html>`;

const dirs: string[] = [];

function clientDirWithIndex(): string {
  const dir = mkdtempSync(join(tmpdir(), "report-pages-"));
  writeFileSync(join(dir, "index.html"), INDEX_HTML);
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length)
    rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("report pages HTML escaping", () => {
  test("escapes an HTML-injecting domain route param", async () => {
    const app = createReportPagesRoutes(clientDirWithIndex());
    // No `/`, `?`, or `#` — normalizeDomain() would otherwise truncate the
    // payload at the first one, masking whether esc() actually escapes it.
    const malicious = 'evil.com"><svg onload=alert(1)>';

    const res = await app.request(`/${encodeURIComponent(malicious)}`);
    const html = await res.text();

    expect(html).not.toContain('"><svg onload=alert(1)>');
    expect(html).toContain("&quot;&gt;&lt;svg onload=alert(1)&gt;");
  });
});
