import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { act, fireEvent, render } from "@testing-library/react";
import { KEEP_TYPING_GAP_MS, useKeepTyping } from "./keep-typing";

const clock = { now: 0 };
const now = () => clock.now;

/**
 * A form's field and a dialog that takes focus as it opens, as the conflict
 * dialog does: `opener.open()` notes the field (onOpenAutoFocus), then
 * focuses the dialog.
 */
function Harness({
  opener,
  enabled = true,
}: {
  opener: { open: () => void };
  enabled?: boolean;
}) {
  // The conflict dialog's: enabled while it is open (v8 sites only).
  const noteTyping = useKeepTyping(enabled, now);
  opener.open = () => {
    noteTyping();
    document.getElementById("dialog")?.focus();
  };
  return (
    <>
      <input aria-label="Headline" defaultValue="Probe B mo" />
      <div id="dialog" role="alertdialog" tabIndex={-1}>
        <input type="radio" aria-label="You" />
      </div>
    </>
  );
}

function setup(values: string[] = [], enabled = true) {
  clock.now = 0;
  const opener = { open: () => {} };
  const view = render(<Harness opener={opener} enabled={enabled} />);
  const field = view.getByRole("textbox", {
    name: "Headline",
  }) as HTMLInputElement;
  // The field's own input events, as the form's change handler hears them
  // (React's, in a browser).
  field.addEventListener("input", () => values.push(field.value));
  const dialog = view.getByRole("alertdialog");
  /** Opens the dialog while `focused` has focus, the caret at `caret`. */
  const openOn = (focused: HTMLElement = field, caret?: number) => {
    focused.focus();
    if (focused === field) {
      const at = caret ?? field.value.length;
      field.setSelectionRange(at, at);
    }
    act(() => opener.open());
  };
  return { view, field, dialog, openOn };
}

function typeOn(target: HTMLElement, keys: string[], gap = 40) {
  for (const key of keys) {
    clock.now += gap;
    act(() => {
      fireEvent.keyDown(target, { key });
    });
  }
}

describe("keystrokes typed as the conflict dialog opens", () => {
  it("go on into the field they were typed into: none is lost", () => {
    const values: string[] = [];
    const { field, dialog, openOn } = setup(values);
    openOn();
    expect(document.activeElement).toBe(dialog);
    typeOn(dialog, ["r", "e"]);
    expect(field.value).toBe("Probe B more");
    // The field's own input event ran for each: the form's value follows.
    expect(values).toEqual(["Probe B mor", "Probe B more"]);
    // Focus stays on the dialog.
    expect(document.activeElement).toBe(dialog);
  });

  it("at the caret, Backspace included", () => {
    const { field, dialog, openOn } = setup();
    openOn(field, 5);
    typeOn(dialog, ["Backspace", "!", "Shift", "?"]);
    expect(field.value).toBe("Prob!? B mo");
  });

  it("only the burst going on as it opened: a pause ends it", () => {
    const { field, dialog, openOn } = setup();
    openOn();
    typeOn(dialog, ["r"], KEEP_TYPING_GAP_MS + 1);
    typeOn(dialog, ["e"]);
    expect(field.value).toBe("Probe B mo");
  });

  it("a key that isn't text, or a click on the dialog, ends it", () => {
    const { field, dialog, openOn } = setup();
    openOn();
    typeOn(dialog, ["r", "ArrowRight", "e"]);
    expect(field.value).toBe("Probe B mor");

    openOn();
    typeOn(dialog, ["e"]);
    expect(field.value).toBe("Probe B more");
    act(() => {
      fireEvent.pointerDown(dialog);
    });
    typeOn(dialog, ["!"]);
    expect(field.value).toBe("Probe B more");
  });

  it("a shortcut ends it too, and isn't typed", () => {
    const { field, dialog, openOn } = setup();
    openOn();
    clock.now += 40;
    act(() => {
      fireEvent.keyDown(dialog, { key: "a", metaKey: true });
    });
    typeOn(dialog, ["x"]);
    expect(field.value).toBe("Probe B mo");
  });

  it("nothing is typed anywhere when no field had focus as it opened", () => {
    const { view, field, dialog, openOn } = setup();
    openOn(view.getByRole("radio", { name: "You" }));
    typeOn(dialog, ["r"]);
    expect(field.value).toBe("Probe B mo");
  });
});

describe("a v7 site's conflict dialog (keepTyping off)", () => {
  it("keeps the keystrokes on the dialog, as before: the field is untouched", () => {
    const values: string[] = [];
    const { field, dialog, openOn } = setup(values, false);
    openOn();
    expect(document.activeElement).toBe(dialog);
    typeOn(dialog, ["r", "e"]);
    expect(field.value).toBe("Probe B mo");
    expect(values).toEqual([]);
  });
});
