import { expect, test } from "bun:test";
import { detachCommands, runDetachCommand } from "./detach-mount";

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

// Regression: detachMountAsync (used by mounter.ts's mount()/unmount() on the
// daemon's live event loop) must never freeze that loop the way the old
// Bun.spawnSync-based detach did — a wedged fusermount/umount would otherwise
// stall the daemon's health probe for the full command timeout, and a single
// missed probe flips a healthy sandbox to "crashed" (CONTRIBUTING.md). Proof:
// a setTimeout(0) scheduled just before a deliberately slow (~250ms) command
// must fire before that command resolves. A blocking spawnSync-based
// implementation would starve the loop and the timer would never get a
// chance to run first, so this fails on the old implementation.
test("runDetachCommand does not block the event loop", async () => {
  let timerFired = false;
  setTimeout(() => {
    timerFired = true;
  }, 0);

  const start = Date.now();
  const code = await runDetachCommand(
    [process.execPath, "-e", "const s=Date.now();while(Date.now()-s<250);"],
    5000,
  );

  expect(code).toBe(0);
  expect(Date.now() - start).toBeGreaterThanOrEqual(200);
  expect(timerFired).toBe(true);
});
