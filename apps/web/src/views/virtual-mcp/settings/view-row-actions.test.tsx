import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Beaker02, Lightning01 } from "@untitledui/icons";
import { SidebarViewIcon } from "./view-row-actions";

const markup = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("SidebarViewIcon: Experiments", () => {
  it("v7 (and any non-Blocks site): the generic icon, as before", () => {
    expect(markup(<SidebarViewIcon viewId="experiments" />)).toBe(
      markup(<Lightning01 size={16} />),
    );
    expect(
      markup(<SidebarViewIcon viewId="experiments" blocksSite={false} />),
    ).toBe(markup(<Lightning01 size={16} />));
  });

  it("v8: the beaker, as in the sidebar", () => {
    expect(markup(<SidebarViewIcon viewId="experiments" blocksSite />)).toBe(
      markup(<Beaker02 size={16} />),
    );
  });
});
