/**
 * A stub harness for the dispatch conformance tests.
 *
 * Speaks the real harness wire — `{harnessId, input}` as JSON on stdin,
 * newline-delimited `{chunks, error}` frames on stdout — without Bun, the Claude
 * Agent SDK or a model provider. `input.harness.stubMode` picks the behaviour
 * under test, so one daemon serves every case:
 *
 *   ok      echo the input back as a chunk (the default)
 *   crash   print nothing and exit non-zero
 *   noisy   print an unrelated line on stdout before the result
 *   hang    never exit, so the test can cancel the run
 *   frames  print three frames, spaced, then exit
 *   slow    print four frames 400ms apart, then exit — long enough for the test
 *           to check that streaming keeps the pod's idle clock reset
 *   live    take live messages: ack each and echo its id as a frame; a message
 *           whose text is "finish" is refused and ends the run
 *
 * The envelope is stdin's first line: a run with live messages keeps stdin open
 * after it.
 */
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
const lines = rl[Symbol.asyncIterator]();
const first = await lines.next();
const body = JSON.parse(first.done ? "" : first.value);
const mode = body.input?.harness?.stubMode ?? "ok";

if (mode === "live") {
  console.log(JSON.stringify({ chunks: [{ type: "started" }] }));
  for (let next = await lines.next(); !next.done; next = await lines.next()) {
    const message = JSON.parse(next.value).liveMessage;
    if (!message) continue;
    const accepted = message.text !== "finish";
    console.log(
      JSON.stringify({ liveMessageAck: { id: message.id, accepted } }),
    );
    if (!accepted) break;
    console.log(JSON.stringify({ chunks: [{ type: "live", id: message.id }] }));
  }
  // Exit by letting go of stdin: `process.exit` could drop buffered stdout.
  rl.close();
  process.stdin.destroy();
} else if (mode === "crash") {
  process.stderr.write("stub harness dying\n");
  process.exit(1);
} else if (mode === "hang") {
  setInterval(() => {}, 1000);
} else if (mode === "frames" || mode === "slow") {
  rl.close();
  const total = mode === "slow" ? 4 : 3;
  const every = mode === "slow" ? 400 : 50;
  let n = 0;
  const timer = setInterval(() => {
    console.log(
      JSON.stringify({ chunks: [{ type: "text-delta", id: `${++n}` }] }),
    );
    if (n === total) {
      clearInterval(timer);
    }
  }, every);
} else {
  rl.close();
  if (mode === "noisy") console.log("a runtime warning nobody asked for");
  console.log(
    JSON.stringify({
      chunks: [
        {
          type: "text-delta",
          id: "1",
          // Echoed so the test can prove the input and run env reached the
          // harness, and that `/repo` was rebased onto the pod's app root.
          delta: JSON.stringify({
            harnessId: body.harnessId,
            threadId: body.input?.threadId,
            cwd: body.input?.workspace?.cwd ?? null,
            hasExpectedApiKey: process.env.ANTHROPIC_API_KEY === "sk-e2e",
          }),
        },
      ],
      error: null,
    }),
  );
}
