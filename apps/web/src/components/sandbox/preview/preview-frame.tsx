import type { ComponentProps } from "react";

/** Shared frame surface. Each host owns its navigation and sandbox policy. */
export function PreviewFrame({ sandbox, ...props }: ComponentProps<"iframe">) {
  return <iframe sandbox={sandbox} {...props} />;
}
