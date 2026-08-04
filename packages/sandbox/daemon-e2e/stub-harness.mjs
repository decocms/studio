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
 */
import { readFileSync } from "node:fs";

const body = JSON.parse(readFileSync(0, "utf8"));
const mode = body.input?.harness?.stubMode ?? "ok";

if (mode === "crash") {
  process.stderr.write("stub harness dying\n");
  process.exit(1);
}
if (mode === "hang") {
  setInterval(() => {}, 1000);
} else if (mode === "frames" || mode === "slow") {
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
  if (mode === "noisy") console.log("a runtime warning nobody asked for");
  console.log(
    JSON.stringify({
      chunks: [
        {
          type: "text-delta",
          id: "1",
          // Echoed so the test can prove the envelope and the run env reached
          // the harness, and that `/repo` was rebased onto the pod's app root.
          delta: JSON.stringify({
            harnessId: body.harnessId,
            threadId: body.input?.threadId,
            cwd: body.input?.workspace?.cwd ?? null,
            apiKey: process.env.ANTHROPIC_API_KEY ?? null,
          }),
        },
      ],
      error: null,
    }),
  );
}
