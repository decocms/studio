import { transform } from "sucrase";
import variant from "@jitl/quickjs-wasmfile-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  DefaultIntrinsics,
  type Intrinsics,
  type QuickJSWASMModule,
  type QuickJSContext,
  type QuickJSHandle,
} from "quickjs-emscripten-core";

import type { StepResult } from "./tool-step";

let quickJSSingleton: Promise<QuickJSWASMModule> | undefined;

function getQuickJS(): Promise<QuickJSWASMModule> {
  quickJSSingleton ??= newQuickJSWASMModuleFromVariant(variant);
  return quickJSSingleton;
}

function toQuickJS(ctx: QuickJSContext, value: unknown): QuickJSHandle {
  switch (typeof value) {
    case "string":
      return ctx.newString(value);
    case "number":
      return ctx.newNumber(value);
    case "boolean":
      return value ? ctx.true : ctx.false;
    case "undefined":
      return ctx.undefined;
    case "object": {
      if (value === null) return ctx.null;
      if (Array.isArray(value)) {
        const arr = ctx.newArray();
        value.forEach((v, i) => {
          const hv = toQuickJS(ctx, v);
          try {
            ctx.setProp(arr, String(i), hv);
          } finally {
            hv.dispose?.();
          }
        });
        return arr;
      }
      const obj = ctx.newObject();
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const hv = toQuickJS(ctx, v);
        try {
          ctx.setProp(obj, k, hv);
        } finally {
          hv.dispose?.();
        }
      }
      return obj;
    }
    default:
      try {
        return ctx.newString(String(value));
      } catch {
        return ctx.undefined;
      }
  }
}

function installConsole(ctx: QuickJSContext): { dispose: () => void } {
  const handles: QuickJSHandle[] = [];

  const makeLog = (level: string) => {
    const logFn = ctx.newFunction(level, (...args: QuickJSHandle[]) => {
      const parts = args.map((h) => ctx.dump(h));
      console.log(`[SANDBOX:${level}]`, ...parts);
      return ctx.undefined;
    });
    handles.push(logFn);
    return logFn;
  };

  const consoleObj = ctx.newObject();
  handles.push(consoleObj);

  const log = makeLog("log");
  const warn = makeLog("warn");
  const error = makeLog("error");

  ctx.setProp(consoleObj, "log", log);
  ctx.setProp(consoleObj, "warn", warn);
  ctx.setProp(consoleObj, "error", error);
  ctx.setProp(ctx.global, "console", consoleObj);

  return {
    dispose() {
      handles.forEach((h) => h.dispose());
    },
  };
}

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

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

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

interface SandboxContextOptions extends Intrinsics {
  interruptAfterMs?: number;
}

/**
 * Creates a fresh QuickJS runtime per execution to avoid concurrency issues.
 * The runtime and context are disposed together in the returned dispose().
 */
async function createSandboxContext(
  runtimeOptions: { memoryLimitBytes?: number; stackSizeBytes?: number },
  contextOptions: SandboxContextOptions = {},
): Promise<{ ctx: QuickJSContext; dispose: () => void }> {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime({
    maxStackSizeBytes: runtimeOptions.stackSizeBytes,
    memoryLimitBytes: runtimeOptions.memoryLimitBytes,
  });

  const { interruptAfterMs, ...intrinsics } = contextOptions;
  const ctx = runtime.newContext({
    intrinsics: { ...DefaultIntrinsics, ...intrinsics },
  });

  if (interruptAfterMs) {
    const deadline = Date.now() + interruptAfterMs;
    runtime.setInterruptHandler(() => Date.now() > deadline);
  }

  return {
    ctx,
    dispose() {
      ctx.dispose();
      runtime.dispose();
    },
  };
}

function transpileTypeScript(code: string): string {
  const result = transform(code, {
    transforms: ["typescript"],
    disableESTransforms: true,
  });
  return result.code;
}

export async function executeCode(
  code: string,
  input: unknown,
  stepName: string,
  timeoutMs = 10_000,
): Promise<StepResult> {
  const startedAt = Date.now();
  let sandbox: { ctx: QuickJSContext; dispose: () => void } | undefined;

  try {
    const jsCode = transpileTypeScript(code);

    sandbox = await createSandboxContext(
      { memoryLimitBytes: 64 * 1024 * 1024, stackSizeBytes: 1 << 20 },
      { interruptAfterMs: timeoutMs },
    );

    const { ctx } = sandbox;
    const consoleBuiltin = installConsole(ctx);

    try {
      const moduleRes = ctx.evalCode(jsCode, "transform.js", {
        strict: true,
        strip: true,
        type: "module",
      });
      const exportsOrPromiseHandle = ctx.unwrapResult(moduleRes);

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

      const defaultHandle = ctx.getProp(exportsHandle, "default");
      const defaultType = ctx.typeof(defaultHandle);

      if (defaultType !== "function") {
        defaultHandle.dispose();
        exportsHandle.dispose();
        return {
          stepId: stepName,
          startedAt,
          completedAt: Date.now(),
          error: `Transform must export a default function. Got ${defaultType}.`,
        };
      }

      const inputHandle = toQuickJS(ctx, input);
      const callRes = ctx.callFunction(
        defaultHandle,
        ctx.undefined,
        inputHandle,
      );
      inputHandle.dispose();
      defaultHandle.dispose();
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

      const output = ctx.dump(awaited);
      awaited.dispose();

      return {
        stepId: stepName,
        startedAt,
        completedAt: Date.now(),
        output,
      };
    } finally {
      consoleBuiltin.dispose();
    }
  } catch (err) {
    const baseError = err instanceof Error ? err.message : String(err);

    let enhancedError = baseError;
    if (
      baseError.includes("cannot read property") ||
      baseError.includes("undefined")
    ) {
      try {
        enhancedError = `${baseError}\n\nInput received:\n${JSON.stringify(input, null, 2).substring(0, 500)}`;
      } catch {
        // ignore stringify errors
      }
    }

    return {
      stepId: stepName,
      startedAt,
      completedAt: Date.now(),
      error: enhancedError,
    };
  } finally {
    sandbox?.dispose();
  }
}
