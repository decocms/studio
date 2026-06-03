import { setupComponentTest } from "../../../test/setup"; // happy-dom + jest-dom matchers
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { CenteredComposerPure } from "./centered-composer";

describe("CenteredComposerPure", () => {
  it("renders identity, above-row, input, and icebreakers in vertical order", () => {
    const { getByTestId } = render(
      <CenteredComposerPure
        readOnly={false}
        identity={<div data-testid="identity">id</div>}
        aboveRow={<div data-testid="above-row">above</div>}
        input={<div data-testid="input">input</div>}
        iceBreakers={<div data-testid="ice-breakers">ice</div>}
      />,
    );
    const identity = getByTestId("identity");
    const above = getByTestId("above-row");
    const input = getByTestId("input");
    const ice = getByTestId("ice-breakers");
    expect(identity).toBeInTheDocument();
    expect(above).toBeInTheDocument();
    expect(input).toBeInTheDocument();
    expect(ice).toBeInTheDocument();
    expect(
      identity.compareDocumentPosition(above) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      above.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      input.compareDocumentPosition(ice) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("applies centering layout classes to the outer wrapper", () => {
    const { container } = render(
      <CenteredComposerPure
        readOnly={false}
        identity={null}
        aboveRow={null}
        input={<div data-testid="input">input</div>}
        iceBreakers={null}
      />,
    );
    const outer = container.firstChild as HTMLElement;
    expect(outer.className).toContain("items-center");
    expect(outer.className).toContain("justify-center");
  });

  it("hides identity, above-row, and icebreakers when read-only", () => {
    const { queryByTestId, getByTestId } = render(
      <CenteredComposerPure
        readOnly={true}
        identity={<div data-testid="identity">id</div>}
        aboveRow={<div data-testid="above-row">above</div>}
        input={<div data-testid="input">input</div>}
        iceBreakers={<div data-testid="ice-breakers">ice</div>}
      />,
    );
    expect(queryByTestId("identity")).toBeNull();
    expect(queryByTestId("above-row")).toBeNull();
    expect(queryByTestId("ice-breakers")).toBeNull();
    expect(getByTestId("input")).toBeInTheDocument();
  });
});
