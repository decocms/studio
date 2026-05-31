import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten-core";
import { installConsole, type SandboxLog } from "./builtins/console.ts";
import { createSandboxRuntime } from "./runtime.ts";
import { inspect } from "./utils/error-handling.ts";
import { PendingPromiseTracker, toQuickJS } from "./utils/to-quickjs.ts";
import type { IClient } from "../client-like.ts";
import { sleep } from "@decocms/std";

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
  client: IClient;
  code: string;
  timeoutMs: number;
  memoryLimitBytes?: number;
  stackSizeBytes?: number;
}

export interface RunCodeResult {
  returnValue?: unknown;
  error?: string;
  consoleLogs: SandboxLog[];
}

export async function runCode({
  client,
  code,
  timeoutMs,
  memoryLimitBytes,
  stackSizeBytes,
}: RunCodeOptions): Promise<RunCodeResult> {
  const promiseTracker = new PendingPromiseTracker();

  using runtime = await createSandboxRuntime({
    memoryLimitBytes: memoryLimitBytes ?? 32 * 1024 * 1024,
    stackSizeBytes: stackSizeBytes ?? 512 * 1024,
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

    // Build a plain object so toQuickJS sees own enumerable properties
    // (IClient methods live on the prototype and would be invisible).
    const sandboxClient: IClient = {
      callTool: (params: unknown) =>
        client.callTool(params as Parameters<IClient["callTool"]>[0]),
      listTools: (params?: unknown) =>
        client.listTools(params as Parameters<IClient["listTools"]>[0]),
      listResources: (params?: unknown) =>
        client.listResources(params as Parameters<IClient["listResources"]>[0]),
      readResource: (params: unknown) =>
        client.readResource(params as Parameters<IClient["readResource"]>[0]),
      listResourceTemplates: (params?: unknown) =>
        client.listResourceTemplates(
          params as Parameters<IClient["listResourceTemplates"]>[0],
        ),
      listPrompts: (params?: unknown) =>
        client.listPrompts(params as Parameters<IClient["listPrompts"]>[0]),
      getPrompt: (params: unknown) =>
        client.getPrompt(params as Parameters<IClient["getPrompt"]>[0]),
      getServerCapabilities: () => client.getServerCapabilities(),
      getInstructions: () => client.getInstructions(),
      close: () => client.close(),
    };

    const clientHandle = toQuickJS(
      ctx,
      sandboxClient,
      50,
      0,
      new WeakSet(),
      promiseTracker,
    );

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
      clientHandle.dispose();
      return {
        error: `Code must export default a function (client). Got ${userFnType}. Example: export default async (client) => { /* ... */ }`,
        consoleLogs: consoleBuiltin.logs,
      };
    }

    const callRes = ctx.callFunction(userFnHandle, ctx.undefined, clientHandle);
    clientHandle.dispose();
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
    return { error: inspect(err), consoleLogs: consoleBuiltin.logs };
  } finally {
    // Dispose outstanding deferred promise handles before the runtime is freed.
    // Without this, in-flight host promises (e.g. slow client.callTool calls)
    // leave QuickJS GC objects alive, causing gc_obj_list assertion failures.
    promiseTracker.dispose();
  }
}
