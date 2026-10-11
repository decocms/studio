/**
 * The one empty state of the site editor's local connection: `/site-editor`
 * with no `deco serve` yet, and a project's Preview while Localhost waits for
 * `deco serve` or for the app it reports. Same layout everywhere: the
 * "your computer ↔ Studio" wire (a dot shuttles on it while waiting), a
 * title and lead, optional alerts, numbered steps (with a copyable command)
 * and a footer.
 */

import { type ReactNode, useId } from "react";
import { Browser, Laptop01 } from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import { CommandSnippet } from "./deco-serve-notices";

export interface ServeConnectStep {
  title: string;
  /** Text above the command. */
  body?: ReactNode;
  /** A terminal command, shown with a Copy button. */
  command?: string;
  /** Anything under the command: a note, a status line, an alert, a button. */
  after?: ReactNode;
}

/**
 * Your computer and Studio, joined by a wire. While `waiting`, a dot travels
 * back and forth on it (still, mid-wire, with reduced motion); otherwise the
 * wire is plain.
 */
export function ConnectionWire({ waiting }: { waiting: boolean }) {
  return (
    <div
      aria-hidden="true"
      data-testid="connection-wire"
      data-waiting={waiting ? "true" : "false"}
      className="flex items-center gap-2"
    >
      <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground sm:size-12">
        <Laptop01 className="size-5 sm:size-6" />
      </span>
      <span className="relative flex h-2 w-16 items-center sm:w-20">
        <span className="h-px w-full border-t border-dashed border-muted-foreground/40" />
        {waiting && (
          <span
            data-testid="connection-dot"
            className="absolute top-0 size-2 animate-[connection-shuttle_1.8s_var(--ease-in-out-cubic)_infinite_alternate] rounded-full bg-foreground"
          />
        )}
      </span>
      <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground sm:size-12">
        <Browser className="size-5 sm:size-6" />
      </span>
    </div>
  );
}

function Step({
  index,
  numbered,
  step,
  heading: StepHeading,
}: {
  index: number;
  numbered: boolean;
  step: ServeConnectStep;
  heading: "h2" | "h3";
}) {
  const headingId = useId();
  return (
    <li
      aria-labelledby={headingId}
      className="surface flex flex-col gap-3 p-4 sm:p-5"
    >
      <div className="flex items-center gap-3">
        {numbered && (
          <span
            aria-hidden="true"
            className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium tabular-nums text-foreground"
          >
            {index}
          </span>
        )}
        <StepHeading
          id={headingId}
          className="text-sm font-medium text-foreground"
        >
          {step.title}
        </StepHeading>
      </div>
      <div className={cn("flex min-w-0 flex-col gap-3", numbered && "sm:pl-9")}>
        {step.body && (
          <p className="text-sm text-muted-foreground">{step.body}</p>
        )}
        {step.command && <CommandSnippet command={step.command} />}
        {step.after}
      </div>
    </li>
  );
}

const NO_STEPS: ServeConnectStep[] = [];

export function ServeConnectState({
  title,
  lead,
  waiting,
  alerts,
  steps = NO_STEPS,
  footer,
  headingLevel = 1,
}: {
  title: string;
  lead?: ReactNode;
  /** Studio is waiting for something on this computer to answer. */
  waiting: boolean;
  /** Shown under the lead: a blocked permission, a server that can't be used… */
  alerts?: ReactNode;
  steps?: ServeConnectStep[];
  footer?: ReactNode;
  /** `1` on a page of its own (`/site-editor`), `2` inside a tab. */
  headingLevel?: 1 | 2;
}) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-xl flex-col justify-center gap-6 px-4 py-8 sm:py-12">
        <header
          // Nothing but "connecting…": announce it.
          role={waiting && steps.length === 0 ? "status" : undefined}
          className="flex flex-col items-center gap-3 text-center"
        >
          <ConnectionWire waiting={waiting} />
          <Heading
            tabIndex={-1}
            className="text-balance text-lg font-medium text-foreground outline-none sm:text-xl"
          >
            {title}
          </Heading>
          {lead && (
            <p className="text-pretty text-sm text-muted-foreground">{lead}</p>
          )}
        </header>
        {alerts}
        {steps.length > 0 && (
          <ol className="flex flex-col gap-3">
            {steps.map((step, index) => (
              <Step
                key={step.title}
                index={index + 1}
                numbered={steps.length > 1}
                step={step}
                heading={headingLevel === 1 ? "h2" : "h3"}
              />
            ))}
          </ol>
        )}
        {footer}
      </div>
    </div>
  );
}
