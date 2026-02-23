import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten-core";
import { installConsole, type SandboxLog } from "./builtins/console.ts";
import { createSandboxRuntime } from "./runtime.ts";
import { inspect } from "./utils/error-handling.ts";
import { toQuickJS } from "./utils/to-quickjs.ts";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function executePendingJobs(ctx: {
  runtime: { executePendingJobs: Function };
}) {
  const res = ctx.runtime.executePendingJobs(100);
  try {
    if ("unwrap" in res && typeof res.unwrap === "function") {
      res.unwrap();
    }
  } finally {
    if ("dispose" in res && typeof res.dispose === "function") {
      res.dispose();
    }
  }
}

async function resolvePromiseWithJobPump(
  ctx: QuickJSContext,
  promiseLikeHandle: QuickJSHandle,
  timeoutMs: number,
) {
  const startedAt = Date.now();
  const hostPromise = ctx.resolvePromise(promiseLikeHandle);

  while (true) {
    executePendingJobs(ctx);

    const raced = await Promise.race([hostPromise, sleep(0).then(() => null)]);

    if (raced !== null) {
      return raced;
    }

    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `Timed out after ${timeoutMs}ms while awaiting a QuickJS promise`,
      );
    }
  }
}

export interface RunCodeOptions {
  tools: Record<string, ToolHandler>;
  code: string;
  timeoutMs: number;
}

export interface RunTransformOptions {
  input: unknown;
  code: string;
  timeoutMs: number;
}

export interface RunCodeResult {
  returnValue?: unknown;
  error?: string;
  consoleLogs: SandboxLog[];
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export async function runCode({
  tools,
  code,
  timeoutMs,
}: RunCodeOptions): Promise<RunCodeResult> {
  using runtime = await createSandboxRuntime({
    memoryLimitBytes: 32 * 1024 * 1024,
    stackSizeBytes: 512 * 1024,
  });

  using ctx = runtime.newContext({ interruptAfterMs: timeoutMs });
  using consoleBuiltin = installConsole(ctx);

  try {
    const moduleRes = ctx.evalCode(code, "index.mjs", {
      strip: true,
      strict: true,
      type: "module",
    });
    const exportsOrPromiseHandle = ctx.unwrapResult(moduleRes);

    const toolsHandle = toQuickJS(ctx, tools);
    ctx.setProp(ctx.global, "tools", toolsHandle);

    // When evaluating ES modules, QuickJS can return either:
    // - the module exports object, or
    // - a promise for the module exports (top-level await / async module init)
    const exportsHandle = ctx.runtime.hasPendingJob()
      ? ctx.unwrapResult(
          await resolvePromiseWithJobPump(
            ctx,
            exportsOrPromiseHandle,
            timeoutMs,
          ),
        )
      : exportsOrPromiseHandle;

    if (exportsHandle !== exportsOrPromiseHandle) {
      exportsOrPromiseHandle.dispose();
    }

    const userFnHandle = ctx.getProp(exportsHandle, "default");
    const userFnType = ctx.typeof(userFnHandle);

    if (userFnType !== "function") {
      userFnHandle.dispose();
      exportsHandle.dispose();
      toolsHandle.dispose();
      return {
        error: `Code must export default a function (tools). Got ${userFnType}. Example: export default async (tools) => { /* ... */ }`,
        consoleLogs: consoleBuiltin.logs,
      };
    }

    const callRes = ctx.callFunction(userFnHandle, ctx.undefined, toolsHandle);
    toolsHandle.dispose();
    userFnHandle.dispose();
    exportsHandle.dispose();

    const callHandle = ctx.unwrapResult(callRes);

    const awaitedRes = await resolvePromiseWithJobPump(
      ctx,
      callHandle,
      timeoutMs,
    );
    callHandle.dispose();
    const awaited = ctx.unwrapResult(awaitedRes);

    // Drain any final microtasks (best-effort)
    if (ctx.runtime.hasPendingJob()) {
      executePendingJobs(ctx);
    }

    const value = ctx.dump(awaited);
    awaited.dispose();

    return { returnValue: value, consoleLogs: consoleBuiltin.logs };
  } catch (err) {
    console.log(err);
    return { error: inspect(err), consoleLogs: consoleBuiltin.logs };
  }
}

/**
 * Run sandboxed JS that transforms an input value.
 *
 * The code must `export default (input) => ...` where `input` is the
 * injected value. No tools are available — this is a pure transformation.
 */
export async function runTransform({
  input,
  code,
  timeoutMs,
}: RunTransformOptions): Promise<RunCodeResult> {
  using runtime = await createSandboxRuntime({
    memoryLimitBytes: 32 * 1024 * 1024,
    stackSizeBytes: 512 * 1024,
  });

  using ctx = runtime.newContext({ interruptAfterMs: timeoutMs });
  using consoleBuiltin = installConsole(ctx);

  try {
    const moduleRes = ctx.evalCode(code, "index.mjs", {
      strip: true,
      strict: true,
      type: "module",
    });
    const exportsOrPromiseHandle = ctx.unwrapResult(moduleRes);

    const inputHandle = toQuickJS(ctx, input);
    ctx.setProp(ctx.global, "input", inputHandle);

    const exportsHandle = ctx.runtime.hasPendingJob()
      ? ctx.unwrapResult(
          await resolvePromiseWithJobPump(
            ctx,
            exportsOrPromiseHandle,
            timeoutMs,
          ),
        )
      : exportsOrPromiseHandle;

    if (exportsHandle !== exportsOrPromiseHandle) {
      exportsOrPromiseHandle.dispose();
    }

    const userFnHandle = ctx.getProp(exportsHandle, "default");
    const userFnType = ctx.typeof(userFnHandle);

    if (userFnType !== "function") {
      userFnHandle.dispose();
      exportsHandle.dispose();
      inputHandle.dispose();
      return {
        error: `Code must export default a function (input). Got ${userFnType}. Example: export default (input) => { return input.items.map(i => i.name); }`,
        consoleLogs: consoleBuiltin.logs,
      };
    }

    const callRes = ctx.callFunction(userFnHandle, ctx.undefined, inputHandle);
    inputHandle.dispose();
    userFnHandle.dispose();
    exportsHandle.dispose();

    const callHandle = ctx.unwrapResult(callRes);

    const awaitedRes = await resolvePromiseWithJobPump(
      ctx,
      callHandle,
      timeoutMs,
    );
    callHandle.dispose();
    const awaited = ctx.unwrapResult(awaitedRes);

    if (ctx.runtime.hasPendingJob()) {
      executePendingJobs(ctx);
    }

    const value = ctx.dump(awaited);
    awaited.dispose();

    return { returnValue: value, consoleLogs: consoleBuiltin.logs };
  } catch (err) {
    console.log(err);
    return { error: inspect(err), consoleLogs: consoleBuiltin.logs };
  }
}
