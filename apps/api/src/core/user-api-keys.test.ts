import { expect, it } from "bun:test";
import type { BetterAuthInstance } from "./studio-context";
import { deleteApiKeyForUser } from "./user-api-keys";

it("deletes only the user's own API key", async () => {
  const rows = [
    { id: "mine", userId: "u1" },
    { id: "theirs", userId: "u2" },
  ];
  const deleted: string[] = [];
  const adapter = {
    findOne: async ({ where }: { where: { value: string }[] }) =>
      rows.find((r) => r.id === where[0]?.value) ?? null,
    delete: async ({ where }: { where: { value: string }[] }) => {
      deleted.push(where[0]!.value);
    },
  };
  const auth = {
    $context: Promise.resolve({ adapter }),
  } as never as BetterAuthInstance;
  await expect(deleteApiKeyForUser(auth, "u1", "theirs")).rejects.toThrow(
    "API key not found",
  );
  await deleteApiKeyForUser(auth, "u1", "mine");
  expect(deleted).toEqual(["mine"]);
});
