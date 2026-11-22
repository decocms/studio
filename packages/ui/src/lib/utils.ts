import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/* deco scale names for merging; `rounded-s`/`rounded-l` are Tailwind's start/left sides, so radii S and L use `rounded-(--radius-s)`. */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["xxs", "s", "m", "l", "xxl"],
      radius: ["zero", "m"],
      shadow: ["s", "m", "l"],
      "font-weight": ["regular", "heavy"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
