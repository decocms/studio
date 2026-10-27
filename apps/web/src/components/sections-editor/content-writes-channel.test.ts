import { describe, expect, it } from "bun:test";
import {
  announceContentWrite,
  onContentWrittenElsewhere,
} from "./content-writes-channel";

const CHANNEL = "decocms:content-writes";
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("content-writes-channel", () => {
  it("a write in another view of the draft reaches this one", async () => {
    const heard: string[] = [];
    const stop = onContentWrittenElsewhere((cacheKey) => heard.push(cacheKey));
    const otherTab = new BroadcastChannel(CHANNEL);
    try {
      otherTab.postMessage({ cacheKey: "acme/vm-1/draft-1" });
      otherTab.postMessage({ nothing: true });
      await settle();
      expect(heard).toEqual(["acme/vm-1/draft-1"]);
    } finally {
      stop();
      otherTab.close();
    }
  });

  it("this view's write reaches the other views, not itself", async () => {
    const heard: string[] = [];
    const stop = onContentWrittenElsewhere((cacheKey) => heard.push(cacheKey));
    const otherTab = new BroadcastChannel(CHANNEL);
    const received: unknown[] = [];
    otherTab.addEventListener("message", (event) => received.push(event.data));
    try {
      announceContentWrite("acme/vm-1/draft-1");
      await settle();
      expect(received).toEqual([{ cacheKey: "acme/vm-1/draft-1" }]);
      expect(heard).toEqual([]);
    } finally {
      stop();
      otherTab.close();
    }
  });
});
