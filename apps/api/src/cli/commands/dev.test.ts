import { expect, it } from "bun:test";
import { getCliState, resetCliStateForTests } from "../cli-store";
import { pipeToLogStore } from "./dev";

it("pipeToLogStore keeps lines read before the stream errors, without crashing", () => {
  resetCliStateForTests();

  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (pulls === 1) {
        controller.enqueue(new TextEncoder().encode("[0] hello\n"));
        return;
      }
      controller.error(new Error("pipe broke"));
    },
  });

  pipeToLogStore(stream);

  return new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
    expect(getCliState().logs.map((l) => l.rawLine)).toEqual(["hello"]);
  });
});
