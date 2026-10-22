"use client";

import type * as React from "react";
import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cn } from "../lib/utils.ts";
import { User01 } from "@untitledui/icons";
import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, ReactNode } from "react";

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
        "bg-muted flex size-full items-center justify-center rounded-full",
        className,
      )}
      {...props}
    />
  );
}

// `solid` is for people and for marks that sit alone, like an org in the rail.
const AVATAR_COLORS = {
  tint: [
    "bg-brand-lime-tint text-brand-green-dark dark:bg-brand/20 dark:text-brand",
    "bg-brand-purple-tint text-brand-purple-dark dark:bg-brand-purple/20 dark:text-brand-purple",
    "bg-brand-yellow-tint text-brand-yellow-dark dark:bg-brand-yellow/20 dark:text-brand-yellow",
    "bg-brand-blue-tint text-brand-blue-dark dark:bg-brand-blue/20 dark:text-brand-blue",
  ],
  solid: [
    "bg-brand text-brand-green-dark",
    "bg-brand-purple text-brand-purple-dark",
    "bg-brand-yellow text-brand-yellow-dark",
    "bg-brand-blue text-brand-blue-dark",
  ],
} as const;

const MUTED_COLOR = "bg-muted text-muted-foreground";

function getColorFromString(
  input: string,
  tone: keyof typeof AVATAR_COLORS,
): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = input.charCodeAt(i) + ((hash << 5) - hash);
  }
  const colors = AVATAR_COLORS[tone];
  return colors[Math.abs(hash) % colors.length]!;
}

/** "Ana Souza" → "AS", "Acme" → "A", "" → "?". */
function getInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.charAt(0) ?? "";
  const last = words.length > 1 ? (words.at(-1)?.charAt(0) ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

/* Initials at ~40% of the tile; a square's radius is ~30% of its side, as
   the org rail's. */
const avatarVariants = cva("font-medium", {
  variants: {
    shape: {
      circle: "rounded-full",
      square: "",
    },
    size: {
      "3xs": "size-3 text-[0.4375rem]",
      "2xs": "size-4 text-[0.5625rem]",
      xs: "size-6 text-[0.625rem]",
      sm: "size-8 text-xs",
      md: "size-9 text-sm",
      base: "size-10 text-sm",
      lg: "size-12 text-lg",
      xl: "size-16 text-2xl",
      "2xl": "size-20 text-3xl",
      "3xl": "size-32 text-5xl",
    },
  },
  compoundVariants: [
    { shape: "square", size: "3xs", class: "rounded-[0.1875rem]" },
    { shape: "square", size: "2xs", class: "rounded-sm" },
    { shape: "square", size: "xs", class: "rounded-lg" },
    { shape: "square", size: "sm", class: "rounded-[0.625rem]" },
    { shape: "square", size: "md", class: "rounded-[0.6875rem]" },
    { shape: "square", size: "base", class: "rounded-xl" },
    { shape: "square", size: "lg", class: "rounded-[0.875rem]" },
    { shape: "square", size: "xl", class: "rounded-[1.125rem]" },
    { shape: "square", size: "2xl", class: "rounded-[1.375rem]" },
    { shape: "square", size: "3xl", class: "rounded-[2.25rem]" },
  ],
  defaultVariants: {
    shape: "square",
    size: "base",
  },
});

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

const ICON_SIZES = {
  "3xs": 8,
  "2xs": 8,
  xs: 12,
  sm: 16,
  md: 18,
  base: 20,
  lg: 24,
  xl: 32,
  "2xl": 40,
  "3xl": 64,
} as const;

export type AvatarProps = VariantProps<typeof avatarVariants> &
  HTMLAttributes<HTMLDivElement> & {
    /** Image URL, or `icon://…` for the generic person icon. */
    url?: string;
    /** A name, shown as its initials, or any element. Shown until the image loads. */
    fallback: string | ReactNode;
    objectFit?: "contain" | "cover";
    /** Grey instead of the name's colour: a deleted user, an org in the rail. */
    muted?: boolean;
    /** `solid` fills the tile with the brand colour instead of its tint; circles default to it. */
    tone?: keyof typeof AVATAR_COLORS;
    /** An ink ring outside the tile: the current org in the rail. */
    selected?: boolean;
    shape?: "circle" | "square";
    size?: keyof typeof ICON_SIZES;
  };

/** The image, or the name's initials on its colour; circle for people, square otherwise. */
export function Avatar({
  shape = "square",
  size = "base",
  url,
  fallback,
  objectFit = "cover",
  className,
  muted = false,
  tone = shape === "circle" ? "solid" : "tint",
  selected = false,
  ...props
}: AvatarProps) {
  const color = muted
    ? MUTED_COLOR
    : getColorFromString(typeof fallback === "string" ? fallback : "", tone);
  const tile = cn("flex size-full items-center justify-center", color);

  return (
    <AvatarRoot
      className={cn(
        avatarVariants({ shape, size }),
        // A hairline keeps a white logo from dissolving into the page.
        url && "outline-1 -outline-offset-1 outline-hairline",
        selected && "outline-2 outline-offset-0 outline-foreground",
        className,
      )}
      {...props}
    >
      {url?.startsWith("icon://") ? (
        <div className={tile}>
          <User01 size={ICON_SIZES[size ?? "base"]} />
        </div>
      ) : (
        <>
          {url && (
            <AvatarImage
              src={url}
              loading="lazy"
              alt="Avatar"
              className={avatarImageVariants({ objectFit })}
            />
          )}
          <AvatarFallback
            className={cn(tile, "rounded-none")}
            delayMs={url ? 600 : 0}
          >
            {typeof fallback === "string" ? getInitials(fallback) : fallback}
          </AvatarFallback>
        </>
      )}
    </AvatarRoot>
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
        "bg-muted animate-pulse",
        className,
      )}
    />
  );
};

export { AvatarFallback, AvatarImage };
