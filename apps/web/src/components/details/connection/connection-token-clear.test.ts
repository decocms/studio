import { describe, expect, it } from "bun:test";
import { formValuesToConnectionUpdate } from "./index";
import type { ConnectionFormData } from "./settings-tab/schema";

const baseForm = (over: Partial<ConnectionFormData>): ConnectionFormData => ({
  title: "Conn",
  ui_type: "HTTP",
  connection_url: "https://example.com/mcp",
  connection_token: null,
  ...over,
});

describe("formValuesToConnectionUpdate", () => {
  it("omits connection_token when the field was never touched", () => {
    const update = formValuesToConnectionUpdate(baseForm({}));
    expect("connection_token" in update).toBe(false);
  });

  it("sends an explicit null when the user clears the token", () => {
    const update = formValuesToConnectionUpdate(
      baseForm({ connection_token: "" }),
    );
    expect(update.connection_token).toBeNull();
  });

  it("sends the new token when the user replaces it", () => {
    const update = formValuesToConnectionUpdate(
      baseForm({ connection_token: "new-token" }),
    );
    expect(update.connection_token).toBe("new-token");
  });
});
