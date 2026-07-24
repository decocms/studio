import { type ReactNode, useState } from "react";
import { ChevronDown } from "@untitledui/icons";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@deco/ui/components/collapsible.tsx";
import { cn } from "@deco/ui/lib/utils.js";

type IconComponent = React.ComponentType<{ size?: number; className?: string }>;

/**
 * A collapsible section for the post/category editors — an icon + title
 * disclosure header (like "Post settings" / "Content") with an animated
 * chevron. Both settings and body use it so the editor reads as a small
 * stack of labeled, foldable panels rather than free-floating fields.
 */
export function CollapsibleSection({
  icon: Icon,
  title,
  defaultOpen = false,
  children,
}: {
  icon: IconComponent;
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-4">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
        >
          <Icon size={15} />
          <span className="flex-1 text-left">{title}</span>
          <ChevronDown
            size={15}
            className={cn("transition-transform", open && "rotate-180")}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-2 pt-4">{children}</CollapsibleContent>
    </Collapsible>
  );
}
