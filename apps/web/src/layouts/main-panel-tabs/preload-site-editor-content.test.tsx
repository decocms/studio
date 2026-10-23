import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, mock, test } from "bun:test";
import { render, waitFor } from "@testing-library/react";
import { preloadOnShow } from "./preload-site-editor-content";

describe("preloadOnShow (Experiments and Calendar → site editor)", () => {
  test("fetches the Content route's code once the view shows, not before", async () => {
    const preload = mock(() => Promise.resolve());
    const ref = preloadOnShow(preload);
    const view = render(<p>loading</p>);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(preload).not.toHaveBeenCalled();
    view.rerender(<div ref={ref}>ready</div>);
    await waitFor(() => expect(preload).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
    view.unmount();
  });

  test("a failed fetch never surfaces (the click fetches it again)", async () => {
    const preload = mock(() => Promise.reject(new Error("offline")));
    const view = render(<div ref={preloadOnShow(preload)}>ready</div>);
    await waitFor(() => expect(preload).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
    view.unmount();
  });
});
