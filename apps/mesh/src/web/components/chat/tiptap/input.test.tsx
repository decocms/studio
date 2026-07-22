import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { EditorContent, useCurrentEditor } from "@tiptap/react";
import { TiptapProvider } from "./input";

function EditableProbe() {
  const { editor } = useCurrentEditor();
  return <EditorContent editor={editor} />;
}

function renderProvider(disabled: boolean) {
  return render(
    <TiptapProvider
      tiptapDoc={undefined}
      setTiptapDoc={() => {}}
      disabled={disabled}
    >
      <EditableProbe />
    </TiptapProvider>,
  );
}

describe("TiptapProvider disabled", () => {
  it("makes the editor's DOM node non-editable when disabled", () => {
    const { container } = renderProvider(true);
    const editable = container.querySelector("[contenteditable]");
    expect(editable?.getAttribute("contenteditable")).toBe("false");
  });

  it("keeps the editor's DOM node editable when not disabled", () => {
    const { container } = renderProvider(false);
    const editable = container.querySelector("[contenteditable]");
    expect(editable?.getAttribute("contenteditable")).toBe("true");
  });
});
