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
import type { ConflictAuthor } from "./conflict-author";
import {
  ConflictAuthorLine,
  type ConflictViewer,
  conflictHeading,
  fieldInSentence,
  FormConflictChoices,
  initials,
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

/**
 * The dialog with its choices kept in state, as the editor keeps them:
 * starting on "yours" for every field (defaultConflictChoices).
 */
function Harness({
  onApply,
  only = fields,
  changedAgain = false,
  viewer = null,
  author = null,
}: {
  onApply: (choices: ConflictChoices) => void;
  only?: ConflictField[];
  changedAgain?: boolean;
  viewer?: ConflictViewer | null;
  author?: ConflictAuthor | null;
}) {
  const [choices, setChoices] = useState<ConflictChoices>(() =>
    Object.fromEntries(only.map((field) => [field.pointer, "mine"])),
  );
  return (
    <FormConflictChoices
      fields={only}
      choices={choices}
      changedAgain={changedAgain}
      viewer={viewer}
      author={author}
      onChoose={(pointer, choice) =>
        setChoices((now) => ({ ...now, [pointer]: choice }))
      }
      onChooseAll={(choice) =>
        setChoices(
          Object.fromEntries(only.map((field) => [field.pointer, choice])),
        )
      }
      onApply={() => onApply(choices)}
    />
  );
}

function Heading({
  only,
  author = null,
}: {
  only: ConflictField[];
  author?: ConflictAuthor | null;
}) {
  const heading = conflictHeading(useT(), only, author);
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

  test("one button, named for the card chosen", () => {
    const onApply = mock((_: ConflictChoices) => {});
    const view = render(<Harness onApply={onApply} only={headline} />);
    expect(
      view.getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["Keep yours"]);
    fireEvent.click(view.getByRole("button", { name: "Keep yours" }));
    expect(onApply).toHaveBeenLastCalledWith({ "/headline": "mine" });
    fireEvent.click(view.getByRole("radio", { name: "Someone else" }));
    expect(view.getByRole("radio", { name: "Someone else" })).toBeChecked();
    expect(view.getByRole("radio", { name: "You" })).not.toBeChecked();
    fireEvent.click(view.getByRole("button", { name: "Use theirs" }));
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
    expect(view.getByRole("button", { name: "Keep yours" })).toBeVisible();
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

describe("several fields: a switch per field", () => {
  test("says how many fields changed", () => {
    const view = render(<Heading only={fields} />);
    expect(view.getByRole("heading")).toHaveTextContent(
      "Someone else changed 3 fields while you were editing",
    );
    expect(
      view.getByText("Choose which version to keep for each field."),
    ).toBeInTheDocument();
  });

  test("each field has a Yours / Theirs switch, on yours, showing that side", () => {
    const view = render(<Harness onApply={() => {}} />);
    for (const label of ["Headline", "Banner", "Slides"]) {
      const group = view.getByRole("radiogroup", { name: label });
      expect(within(group).getByRole("radio", { name: "Yours" })).toBeChecked();
      expect(
        within(group).getByRole("radio", { name: "Theirs" }),
      ).not.toBeChecked();
    }
    expect(view.getAllByTestId("conflict-mine")).toHaveLength(3);
    expect(view.queryByTestId("conflict-theirs")).toBeNull();
    expect(marks(view.getAllByTestId("conflict-mine")[0]!)).toEqual([
      "Summer ",
    ]);
  });

  test("switching a field shows their value, lists summarized", () => {
    const view = render(<Harness onApply={() => {}} />);
    expect(view.getByText("1 item")).toBeInTheDocument();
    fireEvent.click(
      within(view.getByRole("radiogroup", { name: "Slides" })).getByRole(
        "radio",
        { name: "Theirs" },
      ),
    );
    expect(view.getByText("2 items")).toBeInTheDocument();
    expect(view.queryByText("1 item")).toBeNull();
  });

  test("the button names the outcome: yours, a mix, theirs", () => {
    const onApply = mock((_: ConflictChoices) => {});
    const view = render(<Harness onApply={onApply} />);
    const buttons = () =>
      view.getAllByRole("button").map((button) => button.textContent);
    expect(buttons()).toEqual(["Use theirs for all", "Keep yours"]);
    fireEvent.click(view.getByRole("button", { name: "Keep yours" }));
    expect(onApply).toHaveBeenLastCalledWith({
      "/headline": "mine",
      "/banner": "mine",
      "/slides": "mine",
    });
    fireEvent.click(
      within(view.getByRole("radiogroup", { name: "Banner" })).getByRole(
        "radio",
        { name: "Theirs" },
      ),
    );
    fireEvent.click(view.getByRole("button", { name: "Keep a mix" }));
    expect(onApply).toHaveBeenLastCalledWith({
      "/headline": "mine",
      "/banner": "theirs",
      "/slides": "mine",
    });
    fireEvent.click(view.getByRole("button", { name: "Use theirs for all" }));
    for (const radio of view.getAllByRole("radio", { name: "Theirs" })) {
      expect(radio).toBeChecked();
    }
    fireEvent.click(view.getByRole("button", { name: "Use theirs" }));
    expect(onApply).toHaveBeenLastCalledWith({
      "/headline": "theirs",
      "/banner": "theirs",
      "/slides": "theirs",
    });
  });
});

describe("FormConflictChoices", () => {
  test("says so when their version changed again while it was open", () => {
    const view = render(<Harness onApply={() => {}} changedAgain />);
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

describe("who made the other change (hosted v8)", () => {
  const minutesAgo = (n: number) =>
    new Date(Date.now() - n * 60_000).toISOString();
  const ana = (at = minutesAgo(3)): ConflictAuthor => ({
    name: "Ana Souza",
    avatarUrl: "https://img/ana.png",
    at,
    you: false,
  });

  test("one field: the title and their card name the member", () => {
    const at = minutesAgo(3);
    const heading = render(<Heading only={headline} author={ana(at)} />);
    expect(heading.getByRole("heading")).toHaveTextContent(
      "Ana changed the headline while you were editing",
    );
    heading.unmount();
    const view = render(
      <Harness onApply={() => {}} only={headline} author={ana(at)} />,
    );
    const theirs = view.getByRole("radio", { name: "Ana Souza" });
    expect(theirs).toHaveAccessibleDescription(
      "saved 3 minutes ago Winter sale on shoes",
    );
    expect(within(theirs).getByText("saved 3 minutes ago")).toHaveAttribute(
      "title",
      new Date(at).toLocaleString("en", {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    );
    // The button keeps "Use theirs": "Usar a de Ana" doesn't read well in pt-br.
    fireEvent.click(theirs);
    expect(view.getByRole("button", { name: "Use theirs" })).toBeVisible();
    // No separate line: the card says who and when.
    expect(view.queryByTestId("form-conflict-author")).toBeNull();
  });

  test("one field: the viewer's own change from another tab or window", () => {
    const author = { name: "Ana", at: minutesAgo(2), you: true };
    const heading = render(<Heading only={headline} author={author} />);
    expect(heading.getByRole("heading")).toHaveTextContent(
      "You changed the headline in another tab or window",
    );
    heading.unmount();
    const view = render(
      <Harness onApply={() => {}} only={headline} author={author} />,
    );
    expect(
      view.getByRole("radio", { name: "You, in another tab or window" }),
    ).toHaveAccessibleDescription("saved 2 minutes ago Winter sale on shoes");
  });

  test("one field, only the time known: someone else, saved when", () => {
    const view = render(
      <Harness
        onApply={() => {}}
        only={headline}
        author={{ at: minutesAgo(5), you: false }}
      />,
    );
    expect(
      view.getByRole("radio", { name: "Someone else" }),
    ).toHaveAccessibleDescription("saved 5 minutes ago Winter sale on shoes");
  });

  test("several fields: the title names them, a line says who and when", () => {
    const at = minutesAgo(3);
    const heading = render(<Heading only={fields} author={ana(at)} />);
    expect(heading.getByRole("heading")).toHaveTextContent(
      "Ana changed 3 fields while you were editing",
    );
    heading.unmount();
    const view = render(<Harness onApply={() => {}} author={ana(at)} />);
    const line = view.getByTestId("form-conflict-author");
    expect(line).toHaveTextContent("Ana Souza · 3 minutes ago");
    const time = line.querySelector("time")!;
    expect(time.getAttribute("datetime")).toBe(at);
    expect(time.getAttribute("title")).toBe(
      new Date(at).toLocaleString("en", {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    );
  });

  test("several fields: the viewer's own change", () => {
    const view = render(
      <Harness
        onApply={() => {}}
        author={{ name: "Ana", at: minutesAgo(2), you: true }}
      />,
    );
    expect(view.getByTestId("form-conflict-author")).toHaveTextContent(
      "You, in another tab or window · 2 minutes ago",
    );
  });

  test("only the time when nobody is known (an id that isn't a member)", () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    const view = render(
      <ConflictAuthorLine
        author={{ at: "2026-10-16T11:55:00Z", you: false }}
        now={now}
      />,
    );
    expect(view.getByTestId("form-conflict-author").textContent).toBe(
      "Changed 5 minutes ago",
    );
  });

  test("no line while it isn't known", () => {
    const view = render(<Harness onApply={() => {}} />);
    expect(view.queryByTestId("form-conflict-author")).toBeNull();
    expect(view.queryByText(/unknown/i)).toBeNull();
  });
});
