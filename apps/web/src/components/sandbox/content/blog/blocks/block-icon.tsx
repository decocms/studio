import { Box } from "@untitledui/icons";
import type { ComponentType, SVGProps } from "react";
import { cn } from "@decocms/ui/lib/utils.ts";
import { getIconComponent } from "@/components/agent-icon";

type IconComponent = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

/**
 * A blog block's avatar: its `@icon` rendered as an image when the schema
 * declares a URL, otherwise the named @untitledui/icons component. Shared by
 * the inserter and the generic block editor's header so a block looks the same
 * wherever it is named.
 */
export function BlockIcon({
  iconName,
  iconUrl,
  alt,
  className,
  size = 16,
}: {
  iconName: string;
  iconUrl?: string;
  alt: string;
  /** Box sizing; defaults to the inserter's `size-8`. */
  className?: string;
  size?: number;
}) {
  const Icon: IconComponent = getIconComponent(iconName) ?? Box;
  return (
    <div
      className={cn(
        "flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted",
        className,
      )}
    >
      {iconUrl ? (
        <img src={iconUrl} alt={alt} className="size-5 object-contain" />
      ) : (
        <Icon size={size} className="text-muted-foreground" />
      )}
    </div>
  );
}
