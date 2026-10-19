import { setupComponentTest } from "../../../test/setup";
setupComponentTest();

import { describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render as renderBare,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom";
import { type ReactNode, useState } from "react";
import { FormConflictChoices } from "./form-conflict-dialog";
import {
  type ConflictChoices,
  type ConflictField,
  resolveFormConflict,
  planFormConflict,
} from "./form-conflict";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const render = (ui: Parameters<typeof renderBare>[0]) =>
  renderBare(ui, { wrapper });

const fields: ConflictField[] = [
  {
    pointer: "/headline",
    label: "Headline",
    mine: "Summer sale on shoes",
    theirs: "Winter sale on shoes",
    schema: { type: "string", title: "Headline" },
  },
  {
    pointer: "/banner",
    label: "Banner",
    mine: "https://cdn.example.com/mine.png",
    theirs: "https://cdn.example.com/theirs.png",
    schema: { type: "string", title: "Banner", format: "image-uri" },
  },
  {
    pointer: "/slides",
    label: "Slides",
    mine: [{ title: "One" }],
    theirs: [{ title: "One" }, { title: "Two" }],
    schema: null,
  },
];

/**
 * The dialog with its choices kept in state, as the editor keeps them:
 * starting on "yours" for every field (defaultConflictChoices).
 */
function Harness({
  onApply,
  changedAgain = false,
}: {
  onApply: (choices: ConflictChoices) => void;
  changedAgain?: boolean;
}) {
  const [choices, setChoices] = useState<ConflictChoices>(() =>
    Object.fromEntries(fields.map((field) => [field.pointer, "mine"])),
  );
  return (
    <FormConflictChoices
      fields={fields}
      choices={choices}
      changedAgain={changedAgain}
      onChoose={(pointer, choice) =>
        setChoices((now) => ({ ...now, [pointer]: choice }))
      }
      onChooseAll={(choice) =>
        setChoices(
          Object.fromEntries(fields.map((field) => [field.pointer, choice])),
        )
      }
      onApply={() => onApply(choices)}
    />
  );
}

// The body of FormConflictDialog. The Radix alert dialog around it (title,
// focus trap, Escape and click outside not closing it) is covered by the e2e: a test file loaded earlier in the same
// run can import Radix before the DOM is registered, and its portal then
// never mounts here.
describe("FormConflictChoices", () => {
  test("lists each field by its label, with both versions", () => {
    const view = render(<Harness onApply={() => {}} />);
    for (const label of ["Headline", "Banner", "Slides"]) {
      expect(view.getByRole("radiogroup", { name: label })).toBeInTheDocument();
    }
    expect(view.getAllByText("Your version")).toHaveLength(3);
    expect(view.getAllByText("Their version")).toHaveLength(3);
  });

  test("marks the words that differ, shows images and summarizes lists", () => {
    const view = render(<Harness onApply={() => {}} />);
    const headline = view.getByRole("radiogroup", { name: "Headline" });
    const marks = [...headline.querySelectorAll("mark")].map(
      (mark) => mark.textContent,
    );
    expect(marks).toEqual(["Summer ", "Winter "]);
    const banner = view.getByRole("radiogroup", { name: "Banner" });
    expect(
      [...banner.querySelectorAll("img")].map((img) => img.getAttribute("src")),
    ).toEqual([
      "https://cdn.example.com/mine.png",
      "https://cdn.example.com/theirs.png",
    ]);
    const slides = view.getByRole("radiogroup", { name: "Slides" });
    expect(within(slides).getByText("1 item")).toBeInTheDocument();
    expect(within(slides).getByText("2 items")).toBeInTheDocument();
  });

  test("starts on yours, so one click saves the user's version", () => {
    const onApply = mock((_: ConflictChoices) => {});
    const view = render(<Harness onApply={onApply} />);
    for (const radio of view.getAllByRole("radio", { name: "Keep yours" })) {
      expect(radio).toBeChecked();
    }
    fireEvent.click(
      view.getByRole("button", { name: "Save selected versions" }),
    );
    expect(onApply).toHaveBeenCalledWith({
      "/headline": "mine",
      "/banner": "mine",
      "/slides": "mine",
    });
  });

  test("saves mixed choices, field by field", () => {
    const onApply = mock((_: ConflictChoices) => {});
    const view = render(<Harness onApply={onApply} />);
    fireEvent.click(
      within(view.getByRole("radiogroup", { name: "Banner" })).getByRole(
        "radio",
        { name: "Use theirs" },
      ),
    );
    fireEvent.click(
      view.getByRole("button", { name: "Save selected versions" }),
    );
    expect(onApply).toHaveBeenCalledWith({
      "/headline": "mine",
      "/banner": "theirs",
      "/slides": "mine",
    });
  });

  test("Use theirs / Keep yours switch every field", () => {
    const onApply = mock((_: ConflictChoices) => {});
    const view = render(<Harness onApply={onApply} />);
    fireEvent.click(view.getByRole("button", { name: "Use theirs" }));
    for (const radio of view.getAllByRole("radio", { name: "Use theirs" })) {
      expect(radio).toBeChecked();
    }
    fireEvent.click(
      view.getByRole("button", { name: "Save selected versions" }),
    );
    expect(onApply).toHaveBeenLastCalledWith({
      "/headline": "theirs",
      "/banner": "theirs",
      "/slides": "theirs",
    });
    fireEvent.click(view.getByRole("button", { name: "Keep yours" }));
    for (const radio of view.getAllByRole("radio", { name: "Keep yours" })) {
      expect(radio).toBeChecked();
    }
  });

  test("has no way to close it without choosing", () => {
    const view = render(<Harness onApply={() => {}} />);
    expect(
      view.getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["Keep yours", "Use theirs", "Save selected versions"]);
    expect(view.queryByText(/mine|decide later/i)).toBeNull();
  });

  test("says so when their version changed again while it was open", () => {
    const view = render(<Harness onApply={() => {}} changedAgain />);
    expect(
      view.getByText(
        "Their version changed again while this was open. The fields below show it.",
      ),
    ).toBeVisible();
  });

  test("the choices it returns resolve the section as picked", () => {
    const plan = planFormConflict({
      ancestor: { headline: "a", subtitle: "a" },
      mine: { headline: "mine", subtitle: "mine" },
      theirs: { headline: "theirs", subtitle: "theirs" },
    });
    expect(
      resolveFormConflict(plan, { "/headline": "mine", "/subtitle": "theirs" }),
    ).toEqual({ headline: "mine", subtitle: "theirs" });
  });
});
