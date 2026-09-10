/**
 * React type augmentations.
 *
 * Its own file, not `globals.d.ts`: that one is a global script, where
 * `declare module "react"` would declare an ambient module that SHADOWS the
 * real one (erasing every React export) instead of merging with it. The
 * top-level `import` here makes this a module, so the block below is a module
 * augmentation and merges as intended.
 */

import "react";

declare module "react" {
  interface InputHTMLAttributes<T> {
    /** Directory picking — supported by every browser we target, but missing
     *  from React's DOM attribute types. */
    webkitdirectory?: string;
  }
}
