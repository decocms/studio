/* eslint-disable ban-memoization/ban-memoization */
"use client";

import type * as React from "react";
import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cn } from "../lib/utils.ts";
import { User01 } from "@untitledui/icons";
import { cva, type VariantProps } from "class-variance-authority";
import { type HTMLAttributes, type ReactNode, useMemo } from "react";

// Export basic primitives for backward compatibility
function AvatarRoot({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Root>) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      className={cn(
        "relative flex size-8 shrink-0 overflow-hidden rounded-full",
        className,
      )}
      {...props}
    />
  );
}

function AvatarImage({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn("aspect-square size-full", className)}
      {...props}
    />
  );
}

function AvatarFallback({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        "bg-neutral-3 text-neutral-8 font-medium flex size-full items-center justify-center rounded-full",
        className,
      )}
      {...props}
    />
  );
}

// Enhanced Avatar with color generation, shapes, sizes, and icon support

// Identity colours: a tint of each theme hue with the hue pulled toward the ink, so the pair holds in both modes.
const AVATAR_COLORS = [
  "bg-chart-1/20 text-[color-mix(in_srgb,var(--chart-1)_55%,var(--foreground))]",
  "bg-chart-2/25 text-[color-mix(in_srgb,var(--chart-2)_55%,var(--foreground))]",
  "bg-chart-3/20 text-[color-mix(in_srgb,var(--chart-3)_55%,var(--foreground))]",
  "bg-chart-4/25 text-[color-mix(in_srgb,var(--chart-4)_55%,var(--foreground))]",
  "bg-warning/20 text-[color-mix(in_srgb,var(--warning)_55%,var(--foreground))]",
  "bg-destructive/20 text-[color-mix(in_srgb,var(--destructive)_55%,var(--foreground))]",
];

const MUTED_COLOR = "bg-neutral-3 text-neutral-8";

/**
 * Generate a deterministic color from a string
 */
function getColorFromString(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = input.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % AVATAR_COLORS.length;
  return AVATAR_COLORS[index]!;
}

// Unified avatar variants with shape and size
const avatarVariants = cva("font-medium", {
  variants: {
    shape: {
      circle: "rounded-full",
      square: "",
    },
    size: {
      "3xs": "w-3 h-3 text-xxs",
      "2xs": "w-4 h-4 text-xxs",
      xs: "w-6 h-6 text-xxs",
      sm: "w-8 h-8 text-s",
      base: "w-10 h-10 text-m",
      lg: "w-12 h-12 text-l",
      xl: "w-16 h-16 text-l",
      "2xl": "w-20 h-20 text-xl",
      "3xl": "w-32 h-32 text-xxl",
    },
  },
  compoundVariants: [
    // Square avatar roundedness based on size
    { shape: "square", size: "xs", class: "rounded-(--radius-s)" },
    { shape: "square", size: "sm", class: "rounded-m" },
    { shape: "square", size: "base", class: "rounded-m" },
    { shape: "square", size: "lg", class: "rounded-m" },
    { shape: "square", size: "xl", class: "rounded-(--radius-l)" },
    { shape: "square", size: "2xl", class: "rounded-(--radius-l)" },
    { shape: "square", size: "3xl", class: "rounded-xl" },
  ],
  defaultVariants: {
    shape: "square",
    size: "base",
  },
});

// Image variants for object-fit
const avatarImageVariants = cva("", {
  variants: {
    objectFit: {
      contain: "object-contain",
      cover: "object-cover",
    },
  },
  defaultVariants: {
    objectFit: "cover",
  },
});

// Icon size mapping based on avatar size (in pixels)
const getIconSize = (size: string): number => {
  const iconSizes = {
    "3xs": 8,
    "2xs": 8,
    xs: 12,
    sm: 16,
    base: 24,
    lg: 28,
    xl: 36,
    "2xl": 48,
    "3xl": 80,
  };
  return iconSizes[size as keyof typeof iconSizes] || iconSizes.base;
};

interface BaseAvatarProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * The URL of the avatar image
   */
  url?: string;
  /**
   * Fallback text or element to display when the image is not available
   * If string is provided, it will use the first character (typically first initial)
   */
  fallback: string | ReactNode;
  /**
   * The object fit of the avatar image
   */
  objectFit?: "contain" | "cover";
  /**
   * Additional CSS classes to apply to the avatar
   */
  className?: string;
  /**
   * Whether to use the muted color palette
   */
  muted?: boolean;
  /**
   * The shape of the avatar
   */
  shape?: "circle" | "square";
  /**
   * The size of the avatar
   */
  size?: "3xs" | "2xs" | "xs" | "sm" | "base" | "lg" | "xl" | "2xl" | "3xl";
}

/**
 * UnifiedAvatar - Handles both circle and square avatars with variants
 * Internal component - use Avatar with shape prop instead
 */
function UnifiedAvatar({
  url,
  fallback,
  shape = "square",
  size = "base",
  objectFit = "cover",
  className,
  muted = false,
  ...props
}: BaseAvatarProps) {
  const fallbackContent = useMemo(() => {
    if (typeof fallback === "string") {
      const trimmed = fallback.trim();
      return trimmed.slice(0, 2).toUpperCase();
    }
    return fallback;
  }, [fallback]);

  const fallbackColor = useMemo(() => {
    if (muted) {
      return MUTED_COLOR;
    }
    if (typeof fallback === "string") {
      return getColorFromString(fallback);
    }
    return AVATAR_COLORS[0];
  }, [fallback, muted]);

  const isIconUrl = url?.startsWith("icon://");
  const iconName = isIconUrl ? url?.replace("icon://", "") : undefined;

  return (
    <AvatarRoot
      className={cn(avatarVariants({ shape, size }), className)}
      {...props}
    >
      {isIconUrl && iconName ? (
        <div
          className={cn(
            "flex items-center justify-center w-full h-full",
            fallbackColor,
          )}
        >
          <User01 size={getIconSize(size)} />
        </div>
      ) : (
        <>
          {url && (
            <AvatarImage
              src={url}
              loading="lazy"
              alt="Avatar"
              className={cn(avatarImageVariants({ objectFit }))}
            />
          )}
          <AvatarFallback
            className={cn(fallbackColor, "rounded-none")}
            delayMs={url ? 600 : 0}
          >
            {fallbackContent}
          </AvatarFallback>
        </>
      )}
    </AvatarRoot>
  );
}

export type AvatarProps = VariantProps<typeof avatarVariants> & BaseAvatarProps;

/**
 * Avatar - Universal avatar component with shape variant
 *
 * @param shape - 'circle' for user profiles, 'square' for brands/agents (default: 'square')
 * @param size - Size variant (default: 'base')
 * @param url - Image URL or icon:// format
 * @param fallback - Fallback text or element when image fails to load
 * @param objectFit - How the image should fit within the container
 * @param className - Additional CSS classes
 * @param muted - Whether to use muted colors
 */
export function Avatar({
  shape = "square",
  size = "base",
  url,
  fallback,
  objectFit = "cover",
  className,
  muted = false,
  ...props
}: AvatarProps) {
  return (
    <UnifiedAvatar
      shape={shape}
      url={url}
      fallback={fallback}
      size={size ?? "base"}
      objectFit={objectFit}
      className={className}
      muted={muted}
      {...props}
    />
  );
}

// Skeleton for Avatar
Avatar.Skeleton = function AvatarSkeleton({
  shape = "square",
  size = "base",
  className,
}: Pick<AvatarProps, "shape" | "size" | "className">) {
  return (
    <div
      className={cn(
        avatarVariants({ shape, size }),
        "bg-neutral-3 animate-pulse",
        className,
      )}
    />
  );
};

export { AvatarFallback, AvatarImage };
