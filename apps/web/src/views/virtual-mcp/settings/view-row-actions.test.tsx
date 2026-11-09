import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Beaker02, Calendar } from "@untitledui/icons";
import { SidebarViewIcon } from "./view-row-actions";

const markup = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("SidebarViewIcon", () => {
  it("Experiments: the beaker, as in the sidebar and the Apps grid", () => {
    expect(markup(<SidebarViewIcon viewId="experiments" />)).toBe(
      markup(<Beaker02 size={16} />),
    );
  });

  it("Calendar keeps its own", () => {
    expect(markup(<SidebarViewIcon viewId="calendar" />)).toBe(
      markup(<Calendar size={16} />),
    );
  });
});
