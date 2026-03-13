import { cn } from "@deco/ui/lib/utils.ts";
import { Container } from "@untitledui/icons";
import { useState, type ReactNode } from "react";

interface IntegrationIconProps {
  icon: string | null | undefined;
  name: string;
  size?: Size;
  className?: string;
  fallbackIcon?: ReactNode;
}

const SIZE_CLASSES = {
  "2xs": "h-4 w-4",
  xs: "h-6 w-6",
  sm: "h-9 w-9",
  md: "h-12 w-12",
  lg: "h-16 w-16",
  xl: "h-14 w-14",
};

type Size = keyof typeof SIZE_CLASSES;

const MIN_WIDTH_CLASSES: Record<Size, string> = {
  "2xs": "min-w-4",
  xs: "min-w-6",
  sm: "min-w-9",
  md: "min-w-12",
  lg: "min-w-16",
  xl: "min-w-14",
};

const ICON_SIZES: Record<Size, number> = {
  "2xs": 8,
  xs: 12,
  sm: 16,
  md: 24,
  lg: 32,
  xl: 28,
};

export function IntegrationIcon({
  icon,
  name,
  size = "md",
  className,
  fallbackIcon,
}: IntegrationIconProps) {
  // Key the stateful subtree by `icon` so load state resets whenever the icon URL changes,
  // without needing effects.
  return (
    <IntegrationIconStateful
      key={icon ?? "no-icon"}
      icon={icon}
      name={name}
      size={size}
      className={className}
      fallbackIcon={fallbackIcon}
    />
  );
}

function IntegrationIconStateful({
  icon,
  name,
  size = "md",
  className,
  fallbackIcon,
}: IntegrationIconProps) {
  const [loaded, setLoaded] = useState(false);
  const showImage = Boolean(icon) && loaded;

  return (
    <div
      className={cn(
        "rounded-lg border border-border shrink-0 overflow-hidden aspect-square",
        SIZE_CLASSES[size],
        MIN_WIDTH_CLASSES[size],
        className,
      )}
    >
      <img
        src={icon || undefined}
        alt={name}
        className={cn("h-full w-full object-cover", !showImage && "hidden")}
        onError={() => setLoaded(false)}
        onLoad={() => setLoaded(true)}
      />

      {/* Fallback: muted icon with connection symbol */}
      <div
        className={cn(
          "h-full w-full flex items-center justify-center bg-muted/20",
          showImage && "hidden",
        )}
      >
        {fallbackIcon ?? (
          <Container
            size={ICON_SIZES[size]}
            className="text-muted-foreground"
          />
        )}
      </div>
    </div>
  );
}
