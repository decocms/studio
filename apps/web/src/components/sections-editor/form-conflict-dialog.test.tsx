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
import { useT } from "@/i18n/use-t.ts";
import {
  type ConflictViewer,
  conflictHeading,
  fieldInSentence,
  FormConflictChoices,
  initials,
} from "./form-conflict-dialog";
import {
  type ConflictChoices,
  type ConflictField,
  type ConflictFreshness,
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

const noFresh: ConflictFreshness = {};

/**
 * The dialog with its choices kept in state, as the editor keeps them:
 * starting on "yours" for every field (defaultConflictChoices).
 */
function Harness({
  onApply,
  only = fields,
  changedAgain = false,
  viewer = null,
  fresh = noFresh,
}: {
  onApply: (choices: ConflictChoices) => void;
  only?: ConflictField[];
  changedAgain?: boolean;
  viewer?: ConflictViewer | null;
  fresh?: ConflictFreshness;
}) {
  const [choices, setChoices] = useState<ConflictChoices>(() =>
    Object.fromEntries(only.map((field) => [field.pointer, "mine"])),
  );
  return (
    <FormConflictChoices
      fields={only}
      choices={choices}
      changedAgain={changedAgain}
      fresh={fresh}
      viewer={viewer}
      onChoose={(pointer, choice) =>
        setChoices((now) => ({ ...now, [pointer]: choice }))
      }
      onApply={() => onApply(choices)}
    />
  );
}

function Heading({ only }: { only: ConflictField[] }) {
  const heading = conflictHeading(useT(), only);
  return (
    <>
      <h2>{heading.title}</h2>
      <p>{heading.description}</p>
    </>
  );
}

const headline = fields.slice(0, 1);
const marks = (el: HTMLElement) =>
  [...el.querySelectorAll("mark")].map((mark) => mark.textContent);

// The body of FormConflictDialog. The Radix alert dialog around it (focus
// trap, Escape and click outside not closing it) is covered by the e2e: a test
// file loaded earlier in the same run can import Radix before the DOM is
// registered, and its portal then never mounts here.
describe("one field: two cards", () => {
  test("names the field and says the other version is discarded", () => {
    const view = render(<Heading only={headline} />);
    expect(view.getByRole("heading")).toHaveTextContent(
      "Someone else changed the headline while you were editing",
    );
    expect(
      view.getByText("Pick the one to keep. The other is discarded."),
    ).toBeInTheDocument();
  });

  test("each card is a radio, yours first and chosen", () => {
    const view = render(<Harness onApply={() => {}} only={headline} />);
    const group = view.getByRole("radiogroup", { name: "Headline" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
    ]);
    const mine = within(group).getByRole("radio", { name: "You" });
    const theirs = within(group).getByRole("radio", { name: "Someone else" });
    expect(mine).toHaveAccessibleDescription(
      "Your version · not saved yet Summer sale on shoes",
    );
    expect(theirs).toHaveAccessibleDescription(
      "Their version · already saved Winter sale on shoes",
    );
    expect(mine).toHaveAttribute("tabindex", "0");
    expect(theirs).toHaveAttribute("tabindex", "-1");
  });

  test("marks the words that differ in each card", () => {
    const view = render(<Harness onApply={() => {}} only={headline} />);
    expect(marks(view.getByTestId("conflict-mine"))).toEqual(["Summer "]);
    expect(marks(view.getByTestId("conflict-theirs"))).toEqual(["Winter "]);
  });

  test("one button, OK, saves the card chosen", () => {
    const onApply = mock((_: ConflictChoices) => {});
    const view = render(<Harness onApply={onApply} only={headline} />);
    expect(
      view.getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["OK"]);
    fireEvent.click(view.getByRole("button", { name: "OK" }));
    expect(onApply).toHaveBeenLastCalledWith({ "/headline": "mine" });
    fireEvent.click(view.getByRole("radio", { name: "Someone else" }));
    expect(view.getByRole("radio", { name: "Someone else" })).toBeChecked();
    expect(view.getByRole("radio", { name: "You" })).not.toBeChecked();
    fireEvent.click(view.getByRole("button", { name: "OK" }));
    expect(onApply).toHaveBeenLastCalledWith({ "/headline": "theirs" });
  });

  test("arrow keys move the choice, as with radios", () => {
    const view = render(<Harness onApply={() => {}} only={headline} />);
    const mine = view.getByRole("radio", { name: "You" });
    mine.focus();
    fireEvent.keyDown(mine, { key: "ArrowDown" });
    const theirs = view.getByRole("radio", { name: "Someone else" });
    expect(theirs).toBeChecked();
    expect(theirs).toHaveFocus();
    expect(theirs).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(theirs, { key: "ArrowUp" });
    expect(mine).toBeChecked();
    expect(view.getByRole("button", { name: "OK" })).toBeVisible();
  });

  test("your card shows your initials", async () => {
    const view = render(
      <Harness
        onApply={() => {}}
        only={headline}
        viewer={{ name: "Ana Souza", image: null }}
      />,
    );
    expect(
      await within(view.getByRole("radio", { name: "You" })).findByText("AS"),
    ).toBeInTheDocument();
  });

  test("images keep their previews in the cards", () => {
    const view = render(
      <Harness onApply={() => {}} only={fields.slice(1, 2)} />,
    );
    expect(view.getByTestId("conflict-mine").querySelector("img")?.src).toBe(
      "https://cdn.example.com/mine.png",
    );
    expect(view.getByTestId("conflict-theirs").querySelector("img")?.src).toBe(
      "https://cdn.example.com/theirs.png",
    );
  });
});

describe("several fields: one field per step", () => {
  const heading = (view: ReturnType<typeof render>) =>
    view.getByRole("heading").textContent;
  const dots = (view: ReturnType<typeof render>) =>
    within(view.getByRole("group", { name: "Fields to choose" })).getAllByRole(
      "button",
    );
  const step = (view: ReturnType<typeof render>) =>
    view.getByText(/^\d of 3$/).textContent;

  test("a dot per field, each a button named by it, the current one marked", () => {
    const view = render(<Harness onApply={() => {}} />);
    expect(dots(view).map((dot) => dot.getAttribute("aria-label"))).toEqual([
      "Headline",
      "Banner",
      "Slides",
    ]);
    expect(dots(view)[0]).toHaveAttribute("aria-current", "step");
    expect(dots(view)[1]).not.toHaveAttribute("aria-current");
    expect(step(view)).toBe("1 of 3");
  });

  test("each step: the field's title, the hint and the two cards as radios", () => {
    const view = render(<Harness onApply={() => {}} />);
    expect(heading(view)).toBe("Someone else also changed the headline");
    expect(
      view.getByText("Pick the one to keep. You can go back before saving."),
    ).toBeInTheDocument();
    const group = view.getByRole("radiogroup", { name: "Headline" });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((radio) => radio.getAttribute("aria-checked")),
    ).toEqual(["true", "false"]);
    expect(marks(view.getByTestId("conflict-mine"))).toEqual(["Summer "]);
    expect(marks(view.getByTestId("conflict-theirs"))).toEqual(["Winter "]);
  });

  test("Next keeps the pick and moves on; Back and a dot revisit", () => {
    const onApply = mock((_: ConflictChoices) => {});
    const view = render(<Harness onApply={onApply} />);
    fireEvent.click(view.getByRole("radio", { name: "Someone else" }));
    fireEvent.click(view.getByRole("button", { name: "Next" }));
    expect(step(view)).toBe("2 of 3");
    expect(heading(view)).toBe("Someone else also changed the banner");
    expect(view.getByRole("radio", { name: "You" })).toBeChecked();
    expect(dots(view)[0]).toHaveAttribute("data-answered");
    expect(view.getByTestId("conflict-mine").querySelector("img")?.src).toBe(
      "https://cdn.example.com/mine.png",
    );
    fireEvent.click(view.getByRole("button", { name: "Back" }));
    expect(step(view)).toBe("1 of 3");
    expect(view.getByRole("radio", { name: "Someone else" })).toBeChecked();
    fireEvent.click(view.getByRole("button", { name: "Slides" }));
    expect(step(view)).toBe("3 of 3");
    expect(view.getByText("1 item")).toBeInTheDocument();
    expect(view.getByText("2 items")).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
  });

  test("Back does nothing on the first step and keeps focus", () => {
    const view = render(<Harness onApply={() => {}} />);
    const back = view.getByRole("button", { name: "Back" });
    expect(back).toHaveAttribute("aria-disabled", "true");
    back.focus();
    fireEvent.click(back);
    expect(step(view)).toBe("1 of 3");
    expect(back).toHaveFocus();
  });

  test("the ←/→ keys move between steps, but not in a text field", () => {
    const view = render(
      <>
        <Harness onApply={() => {}} />
        <input aria-label="Some text" />
      </>,
    );
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(step(view)).toBe("2 of 3");
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(step(view)).toBe("3 of 3");
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    expect(step(view)).toBe("2 of 3");
    fireEvent.keyDown(view.getByRole("textbox", { name: "Some text" }), {
      key: "ArrowLeft",
    });
    expect(step(view)).toBe("2 of 3");
    fireEvent.keyDown(document.body, { key: "ArrowLeft", shiftKey: true });
    expect(step(view)).toBe("2 of 3");
  });

  test("on a card, ↑/↓ change the pick and ←/→ the step", () => {
    const view = render(<Harness onApply={() => {}} />);
    const mine = view.getByRole("radio", { name: "You" });
    mine.focus();
    fireEvent.keyDown(mine, { key: "ArrowDown" });
    const theirs = view.getByRole("radio", { name: "Someone else" });
    expect(theirs).toBeChecked();
    expect(theirs).toHaveFocus();
    fireEvent.keyDown(theirs, { key: "ArrowRight" });
    expect(step(view)).toBe("2 of 3");
    expect(view.getByRole("radio", { name: "You" })).toBeChecked();
  });

  test("Back and Next on every step, OK on the last", () => {
    const view = render(<Harness onApply={() => {}} />);
    const actions = () =>
      view
        .getAllByRole("button")
        .filter(
          (button) =>
            button.getAttribute("role") !== "radio" &&
            !button.closest('[aria-label="Fields to choose"]'),
        )
        .map((button) => button.textContent);
    expect(actions()).toEqual(["Back", "Next"]);
    fireEvent.click(view.getByRole("button", { name: "Next" }));
    expect(actions()).toEqual(["Back", "Next"]);
    fireEvent.click(view.getByRole("button", { name: "Next" }));
    expect(step(view)).toBe("3 of 3");
    expect(actions()).toEqual(["Back", "OK"]);
  });

  test("yours by default; OK on the last step saves the picks", () => {
    const onApply = mock((_: ConflictChoices) => {});
    const view = render(<Harness onApply={onApply} />);
    fireEvent.click(view.getByRole("button", { name: "Slides" }));
    expect(view.queryByRole("button", { name: "Next" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "OK" }));
    expect(onApply).toHaveBeenLastCalledWith({
      "/headline": "mine",
      "/banner": "mine",
      "/slides": "mine",
    });
    fireEvent.click(view.getByRole("radio", { name: "Someone else" }));
    fireEvent.click(view.getByRole("button", { name: "OK" }));
    expect(onApply).toHaveBeenLastCalledWith({
      "/headline": "mine",
      "/banner": "mine",
      "/slides": "theirs",
    });
    expect(onApply).toHaveBeenCalledTimes(2);
  });

  test("the second click of a double click on Next doesn't save", () => {
    const onApply = mock((_: ConflictChoices) => {});
    const view = render(<Harness onApply={onApply} />);
    fireEvent.click(view.getByRole("button", { name: "Next" }));
    fireEvent.click(view.getByRole("button", { name: "Next" }), { detail: 1 });
    fireEvent.click(view.getByRole("button", { name: "OK" }), {
      detail: 2,
    });
    expect(onApply).not.toHaveBeenCalled();
  });

  test("the last step sums up the picks instead of the hint", () => {
    const view = render(<Harness onApply={() => {}} />);
    fireEvent.click(view.getByRole("button", { name: "Next" }));
    fireEvent.click(view.getByRole("radio", { name: "Someone else" }));
    fireEvent.click(view.getByRole("button", { name: "Next" }));
    expect(heading(view)).toBe("Someone else also changed the slides");
    expect(view.getByTestId("form-conflict-summary")).toHaveTextContent(
      "Headline: yours · Banner: theirs · Slides: yours",
    );
    expect(
      view.queryByText("Pick the one to keep. You can go back before saving."),
    ).toBeNull();
  });

  test("a field whose version changed while open gets a ring until visited", () => {
    const view = render(<Harness onApply={() => {}} />);
    view.rerender(<Harness onApply={() => {}} fresh={{ "/slides": 1 }} />);
    const slides = () => view.getByRole("button", { name: /^Slides/ });
    expect(slides()).toHaveAttribute("data-changed-again");
    expect(slides()).toHaveAttribute("aria-label", "Slides, changed again");
    fireEvent.click(slides());
    fireEvent.click(view.getByRole("button", { name: "Back" }));
    expect(slides()).not.toHaveAttribute("data-changed-again");
    expect(slides()).toHaveAttribute("aria-label", "Slides");
    // The step on screen (Banner, after Back) when it changes: seen already.
    view.rerender(
      <Harness onApply={() => {}} fresh={{ "/slides": 1, "/banner": 1 }} />,
    );
    expect(view.getByRole("button", { name: "Banner" })).not.toHaveAttribute(
      "data-changed-again",
    );
    fireEvent.click(view.getByRole("button", { name: "Back" }));
    expect(view.getByRole("button", { name: "Banner" })).not.toHaveAttribute(
      "data-changed-again",
    );
    // Changed again since the last visit.
    view.rerender(
      <Harness onApply={() => {}} fresh={{ "/slides": 2, "/banner": 1 }} />,
    );
    expect(slides()).toHaveAttribute("data-changed-again");
  });

  test("their change while open is said once for all the steps", () => {
    const view = render(<Harness onApply={() => {}} changedAgain />);
    expect(
      view.getByText(
        "Their version changed again while this was open. Each step now shows the newer one.",
      ),
    ).toBeVisible();
  });

  test("one field: no dots, no Back or Next", () => {
    const view = render(<Harness onApply={() => {}} only={headline} />);
    expect(view.queryByRole("group", { name: "Fields to choose" })).toBeNull();
    expect(view.queryByRole("button", { name: "Back" })).toBeNull();
    expect(view.queryByRole("button", { name: "Next" })).toBeNull();
  });
});

describe("FormConflictChoices", () => {
  test("says so when their version changed again while it was open", () => {
    const view = render(
      <Harness onApply={() => {}} only={headline} changedAgain />,
    );
    expect(
      view.getByText(
        "Their version changed again while this was open. It's shown below.",
      ),
    ).toBeVisible();
  });

  test("labels read inside a sentence", () => {
    expect(fieldInSentence("Title")).toBe("title");
    expect(fieldInSentence("SEO")).toBe("SEO");
    expect(fieldInSentence("Cta › Label")).toBe("Cta › Label");
    expect(initials("  ana  souza lima ")).toBe("AS");
    expect(initials(null)).toBe("");
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
