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
import {
  FormConflictChoices,
  FormConflictNotice,
} from "./form-conflict-dialog";
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

/** The dialog with its choices kept in state, as the editor keeps them. */
const noop = () => {};

function Harness({
  onApply,
  onDecideLater = noop,
  changedAgain = false,
}: {
  onApply: (choices: ConflictChoices) => void;
  onDecideLater?: () => void;
  changedAgain?: boolean;
}) {
  const [choices, setChoices] = useState<ConflictChoices>({});
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
      onDecideLater={onDecideLater}
    />
  );
}

// The body of FormConflictDialog. The Radix dialog around it (title, focus
// trap, Escape) is covered by the e2e: a test file loaded earlier in the same
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

  test("applies only once every field has a choice, with mixed choices", () => {
    const onApply = mock((_: ConflictChoices) => {});
    const view = render(<Harness onApply={onApply} />);
    const apply = view.getByRole("button", { name: "Apply" });
    expect(apply).toBeDisabled();
    expect(
      view.getByText("Choose a version for each field to apply."),
    ).toBeInTheDocument();

    const pick = (label: string, name: string) =>
      fireEvent.click(
        within(view.getByRole("radiogroup", { name: label })).getByRole(
          "radio",
          { name },
        ),
      );
    pick("Headline", "Keep mine");
    pick("Banner", "Use theirs");
    expect(apply).toBeDisabled();
    pick("Slides", "Keep mine");
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    expect(onApply).toHaveBeenCalledWith({
      "/headline": "mine",
      "/banner": "theirs",
      "/slides": "mine",
    });
  });

  test("keep all mine / use all theirs choose for every field", () => {
    const onApply = mock((_: ConflictChoices) => {});
    const view = render(<Harness onApply={onApply} />);
    fireEvent.click(view.getByRole("button", { name: "Use all theirs" }));
    for (const radio of view.getAllByRole("radio", { name: "Use theirs" })) {
      expect(radio).toBeChecked();
    }
    fireEvent.click(view.getByRole("button", { name: "Keep all mine" }));
    fireEvent.click(view.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith({
      "/headline": "mine",
      "/banner": "mine",
      "/slides": "mine",
    });
  });

  test("closing it is deciding later", () => {
    const onDecideLater = mock(() => {});
    const view = render(
      <Harness onApply={() => {}} onDecideLater={onDecideLater} />,
    );
    fireEvent.click(view.getByRole("button", { name: "Decide later" }));
    expect(onDecideLater).toHaveBeenCalledTimes(1);
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

describe("FormConflictNotice", () => {
  test("says the changes wait and reopens the choice", () => {
    const onReview = mock(() => {});
    const view = render(<FormConflictNotice onReview={onReview} />);
    expect(
      view.getByText(
        "Your changes to this section aren't saved yet: someone else changed it too.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(view.getByRole("button", { name: "Choose versions" }));
    expect(onReview).toHaveBeenCalledTimes(1);
  });
});
