import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { createRef } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as renderBare } from "@testing-library/react";
import type { ReactNode } from "react";
import { MentionInput, type MentionInputHandle } from "./mention-input";

/**
 * A comment composer has to take an image: "make the spacing match this image"
 * is a comment, and a body with no picture in it is what made a run guess.
 * `uploadFile` is stubbed — the upload itself belongs to `useEditorFileUpload`.
 */
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const render = (ui: Parameters<typeof renderBare>[0]) =>
  renderBare(ui, { wrapper });

const URL_FOR = {
  png: "/api/acme/fs/uploads/read?path=editor-images%2Fabc.png",
  pdf: "/api/acme/fs/uploads/read?path=editor-files%2Fabc.pdf",
};

function setup() {
  const submitted: string[] = [];
  const ref = createRef<MentionInputHandle>();
  render(
    <MentionInput
      ref={ref}
      placeholder="Leave a comment..."
      onSubmit={(markdown) => submitted.push(markdown)}
      onEmptyChange={() => {}}
      uploadFile={async (file) =>
        file.type.startsWith("image/") ? URL_FOR.png : URL_FOR.pdf
      }
    />,
  );
  return { ref, submitted };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("MentionInput file uploads", () => {
  it("submits a pasted image as markdown pointing at the org filesystem", async () => {
    const { ref, submitted } = setup();
    ref.current!.insertFiles([
      new File([new Uint8Array([1])], "shot.png", { type: "image/png" }),
    ]);
    await flush();
    ref.current!.submit();
    expect(submitted[0]).toBe(`![shot.png](${URL_FOR.png})`);
  });

  it("submits a non-image attachment as a link", async () => {
    const { ref, submitted } = setup();
    ref.current!.insertFiles([
      new File([new Uint8Array([1])], "spec.pdf", { type: "application/pdf" }),
    ]);
    await flush();
    ref.current!.submit();
    expect(submitted[0]).toBe(`[spec.pdf](${URL_FOR.pdf})`);
  });
});
