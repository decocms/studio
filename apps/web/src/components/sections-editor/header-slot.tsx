import {
  createContext,
  use,
  useState,
  type Dispatch,
  type ReactNode,
  type RefCallback,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";

/**
 * A slot in the blocks panel's header row, so a field that has taken over the
 * panel can put its own control up there — the header names whatever is open,
 * and a field deep in the schema form has no other way to reach it.
 *
 * Modelled on `Panel`'s target/portal pair: the header renders the target and
 * registers its node through a callback ref, and the field portals into it.
 * Rendering the portal is a no-op until a target exists, so a field can always
 * ask without knowing whether it is inside a panel that offers the slot.
 */
const HeaderSlotContext = createContext<{
  target: HTMLDivElement | null;
  setTarget: Dispatch<SetStateAction<HTMLDivElement | null>>;
} | null>(null);

export function HeaderSlotProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  return (
    <HeaderSlotContext value={{ target, setTarget }}>
      {children}
    </HeaderSlotContext>
  );
}

/** Where a portalled control lands. Collapses when nothing is portalled. */
export function HeaderSlotTarget() {
  const context = use(HeaderSlotContext);
  const [targetRef] = useState<RefCallback<HTMLDivElement>>(
    () => (node: HTMLDivElement | null) => {
      if (!node || !context) return;
      context.setTarget(node);
      return () => {
        context.setTarget((current) => (current === node ? null : current));
      };
    },
  );
  if (!context) return null;
  return <div ref={targetRef} className="contents" />;
}

export function HeaderSlotPortal({ children }: { children: ReactNode }) {
  const context = use(HeaderSlotContext);
  if (!context?.target) return null;
  return createPortal(children, context.target);
}
