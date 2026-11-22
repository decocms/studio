"use client";

import { useTheme } from "next-themes";
import { toast, Toaster as Sonner, type ToasterProps } from "sonner";

// Sonner's unlayered stylesheet outranks layered utilities, hence `!`.
const TOAST_BUTTON =
  "!h-auto !rounded-(--radius-s) !px-(--space-m) !py-(--space-xs) !text-s !font-medium !transition-[background-color,box-shadow,color] !duration-(--motion-duration) !ease-motion !focus-ring";

const Toaster = ({ toastOptions, ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
        } as React.CSSProperties
      }
      toastOptions={{
        ...toastOptions,
        classNames: {
          toast:
            "!gap-(--space-xs) !rounded-m !border-0 !p-(--space-m) !text-s !font-regular !shadow-(--popup-shadow) !duration-(--motion-large-duration) !ease-motion-large !focus-ring",
          title: "!text-m !font-medium",
          description: "!text-s !text-muted-foreground",
          actionButton: `${TOAST_BUTTON} !bg-[var(--studio-secondary-background)] !text-[color:var(--studio-secondary-foreground)] !shadow-(--edge) hover:!bg-[var(--studio-secondary-hover-background)]`,
          cancelButton: `${TOAST_BUTTON} !bg-transparent !text-foreground hover:!bg-neutral-3-transparent`,
          // Straddles the toast corner, so it keeps an opaque fill and edge.
          closeButton:
            "!rounded-(--radius-s) !border-0 !bg-popover !text-foreground !shadow-(--edge) hover:!bg-neutral-3 !focus-ring",
          ...toastOptions?.classNames,
        },
      }}
      {...props}
    />
  );
};

export { toast, Toaster };
