import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();

import { describe, expect, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import {
  ObjectFieldExpansionProvider,
  useObjectFieldExpansion,
} from "../object-field-expansion";

/**
 * Mirrors how `ObjectField` reads its open state: keyed by field path from the
 * shared store. Rendering "OPEN"/"CLOSED" lets the test observe persistence
 * without the SDK-coupled `ObjectField` (whose tooltip hook suspends on a
 * virtual-MCP query).
 */
function Group({ path }: { path: string }) {
  const expansion = useObjectFieldExpansion();
  return (
    <div>
      <span>{expansion?.isExpanded(path) ? "OPEN" : "CLOSED"}</span>
      <button type="button" onClick={() => expansion?.toggle(path)}>
        toggle
      </button>
    </div>
  );
}

function Harness() {
  const [mounted, setMounted] = useState(true);
  return (
    <ObjectFieldExpansionProvider>
      <button type="button" onClick={() => setMounted((m) => !m)}>
        remount
      </button>
      {mounted && <Group path="sizes" />}
    </ObjectFieldExpansionProvider>
  );
}

describe("ObjectFieldExpansionProvider", () => {
  test("keeps a group's open state across an unmount/remount (drill-in/out)", () => {
    const { getByText, queryByText } = render(<Harness />);

    expect(getByText("CLOSED")).toBeInTheDocument();

    // Expand the group.
    fireEvent.click(getByText("toggle"));
    expect(getByText("OPEN")).toBeInTheDocument();

    // Drilling into an array item unmounts sibling groups.
    fireEvent.click(getByText("remount"));
    expect(queryByText("OPEN")).toBeNull();
    expect(queryByText("CLOSED")).toBeNull();

    // Returning remounts the group — it must still read as expanded.
    fireEvent.click(getByText("remount"));
    expect(getByText("OPEN")).toBeInTheDocument();
  });
});
