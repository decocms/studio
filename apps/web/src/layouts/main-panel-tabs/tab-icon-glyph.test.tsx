import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LayoutAlt04 } from "@untitledui/icons";
import { TabIconGlyph } from "./tab-icon-glyph";

describe("TabIconGlyph", () => {
  test("renders component icons", () => {
    const html = renderToStaticMarkup(
      <TabIconGlyph icon={{ kind: "component", Component: LayoutAlt04 }} />,
    );

    expect(html).toContain("<svg");
  });

  test("renders URL icons as decorative images", () => {
    const html = renderToStaticMarkup(
      <TabIconGlyph
        icon={{ kind: "url", src: "https://example.com/icon.png" }}
      />,
    );

    expect(html).toContain("<img");
    expect(html).toContain('src="https://example.com/icon.png"');
    expect(html).toContain('alt=""');
  });

  test("renders a fallback icon", () => {
    const html = renderToStaticMarkup(
      <TabIconGlyph icon={{ kind: "fallback" }} />,
    );

    expect(html).toContain("<svg");
  });
});
