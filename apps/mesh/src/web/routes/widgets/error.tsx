import { useWidget } from "./use-widget.ts";

type ErrorArgs = { message?: string; code?: string; details?: string };

export default function Error() {
  const { args } = useWidget<ErrorArgs>();

  if (!args) return null;

  const { message = "An error occurred", code, details } = args;

  return (
    <div className="p-4 font-sans">
      <div className="flex items-start gap-3">
        <div className="size-8 rounded-full bg-red-100 flex items-center justify-center shrink-0 mt-0.5">
          <span className="text-red-600 text-sm font-bold">!</span>
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-sm font-semibold text-foreground">
              {message}
            </div>
            {code && (
              <span className="text-xs font-mono bg-red-50 text-red-700 px-1.5 py-0.5 rounded border border-red-200">
                {code}
              </span>
            )}
          </div>
          {details && (
            <pre className="mt-2 text-xs text-muted-foreground font-mono bg-muted rounded p-2 overflow-auto max-h-32 whitespace-pre-wrap break-all">
              {details}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
