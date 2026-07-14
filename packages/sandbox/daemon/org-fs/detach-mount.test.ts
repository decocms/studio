import { expect, test } from "bun:test";
import { detachCommands } from "./detach-mount";

// The whole point of the change: teardown must use non-blocking (lazy) detach
// so several unmounts can't serialize past the pod's terminationGracePeriod.
test("linux detach uses lazy flags", () => {
  expect(detachCommands("/app/org/home", false)).toEqual([
    ["fusermount", "-uz", "/app/org/home"],
    ["umount", "-l", "/app/org/home"],
  ]);
});

test("macos detach uses force flag", () => {
  expect(detachCommands("/app/org/home", true)).toEqual([
    ["umount", "-f", "/app/org/home"],
  ]);
});
