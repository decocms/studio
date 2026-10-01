import { describe, expect, it } from "bun:test";
import { withoutDeadPreviews } from "./draft-previews";

describe("withoutDeadPreviews", () => {
  it("drops a preview the draft no longer holds and keeps the live ones", () => {
    const live = new Set(["blob:http://localhost/live"]);
    const markdown =
      "see ![shot.png](blob:http://localhost/live) and [old.pdf](blob:http://localhost/gone)";

    expect(withoutDeadPreviews(markdown, live)).toBe(
      "see ![shot.png](blob:http://localhost/live) and ",
    );
  });

  it("drops a dead preview whose name has brackets in it", () => {
    const markdown = "[spec\\[2\\] \\\\.pdf](blob:http://localhost/gone) sent";

    expect(withoutDeadPreviews(markdown, new Set())).toBe(" sent");
  });

  it("leaves every other link alone", () => {
    const markdown =
      "[docs](https://example.com) ![x](/api/acme/fs/uploads/read?path=a.png)";

    expect(withoutDeadPreviews(markdown, new Set())).toBe(markdown);
  });
});
