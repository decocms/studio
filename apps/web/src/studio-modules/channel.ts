/**
 * The Studio channel: how code that belongs to Deco Studio's site editor
 * runs inside the site's page when Studio frames it. Browser-safe, no
 * dependencies; types plus a few constants, shared by the page's bootstrap
 * (`StudioChannel` in `@decocms/blocks/preview`, which every binding mounts on
 * every page) and Studio, which hosts the modules.
 *
 * The page trusts a list of Studio origins (the binding's: Studio's production
 * and staging origins by default, {@link DEFAULT_STUDIO_ORIGINS}), each
 * compared exactly, no wildcard. It is the only way Studio runs code in the
 * page: no message makes the page evaluate a script.
 *
 * 1. A framed page (`window.parent !== window`) posts `{ type: "deco:ready" }`
 *    to its parent once per trusted origin, each as the `targetOrigin` (the
 *    browser delivers it only if the parent is at that origin, so a parent of
 *    any other origin never receives it). Where the browser names the parent's
 *    origin (`location.ancestorOrigins`), the page posts to that origin alone,
 *    and only when it is trusted.
 * 2. Studio answers `{ type: "deco:load", url }`: an absolute URL of an ES
 *    module on Studio's own origin (versioned, served with CORS).
 * 3. The page accepts the message only when `event.origin` is one of the
 *    trusted origins, the sender is the parent window, and the module URL's
 *    origin is the origin of that message; then it `import()`s the URL, once
 *    per URL, and calls the module's default export with a
 *    {@link StudioChannelContext} bound to that origin. It answers
 *    `{ type: "deco:loaded", url }`, or `{ type: "deco:load-error", url,
 *    message }` (a failed URL may be sent again), to that origin.
 * 4. Every later message from that origin whose `type` doesn't start with
 *    `deco:` (reserved for the channel) is handed to the listeners of each
 *    module it loaded; a module talks back with `send`, to that origin only.
 *
 * Not framed, framed by another origin, or a message that fails a check: the
 * bootstrap does nothing. The binding adds the same origins to the page's
 * Content Security Policy (`script-src`, for the modules, and
 * `frame-ancestors`); the bootstrap's inline script takes the site's `nonce`.
 */

/** Studio's production origin. */
export const DEFAULT_STUDIO_ORIGIN = "https://studio.decocms.com";

/**
 * The origins a page trusts unless the binding option or `DECO_STUDIO_ORIGIN`
 * (comma-separated) says otherwise: Studio's production and staging origins.
 */
export const DEFAULT_STUDIO_ORIGINS: readonly string[] = Object.freeze([
  DEFAULT_STUDIO_ORIGIN,
  "https://studio-stg.decocms.com",
]);

/** The channel's own message types; a module's message types never start with `deco:`. */
export const CHANNEL_MESSAGE = Object.freeze({
  ready: "deco:ready",
  load: "deco:load",
  loaded: "deco:loaded",
  loadError: "deco:load-error",
} as const);

/** Page → Studio: the framed page's bootstrap is listening. */
export interface ChannelReadyMessage {
  type: "deco:ready";
}

/** Studio → page: import this module (an absolute URL on Studio's origin). */
export interface ChannelLoadMessage {
  type: "deco:load";
  url: string;
}

/** Page → Studio: the module at `url` was imported and its default export ran. */
export interface ChannelLoadedMessage {
  type: "deco:loaded";
  url: string;
}

/** Page → Studio: the module at `url` failed to import or to start. */
export interface ChannelLoadErrorMessage {
  type: "deco:load-error";
  url: string;
  message: string;
}

/** What the page's bootstrap posts to Studio. */
export type PageChannelMessage =
  | ChannelReadyMessage
  | ChannelLoadedMessage
  | ChannelLoadErrorMessage;

/** What the page's bootstrap acts on itself; any other message goes to the modules. */
export type StudioChannelMessage = ChannelLoadMessage;

/**
 * A message between Studio and one of its modules: any structured-cloneable
 * object with a `type` that doesn't start with `deco:` (by convention the
 * module's name, `wireframe:hover`).
 */
export interface ModuleMessage {
  type: string;
}

/** What a module's default export is called with. */
export interface StudioChannelContext<
  In extends ModuleMessage = ModuleMessage,
  Out extends ModuleMessage = ModuleMessage,
> {
  /** The Studio origin this module was loaded from (the `deco:load` message's, checked exactly). */
  readonly studioOrigin: string;
  /** The URL this module was loaded from. */
  readonly url: string;
  /** Posts a message to Studio (addressed to `studioOrigin` only). */
  send(message: Out): void;
  /** Listens to Studio's module messages from `studioOrigin`; returns the unsubscribe. */
  on(listener: (message: In) => void): () => void;
}

/** A module's default export. The page answers `deco:loaded` once it returns (or its promise resolves). */
export type StudioChannelModule<
  In extends ModuleMessage = ModuleMessage,
  Out extends ModuleMessage = ModuleMessage,
> = (context: StudioChannelContext<In, Out>) => void | Promise<void>;

/** Types a module's default export: `export default defineStudioModule<In, Out>((channel) => …)`. */
export function defineStudioModule<
  In extends ModuleMessage = ModuleMessage,
  Out extends ModuleMessage = ModuleMessage,
>(module: StudioChannelModule<In, Out>): StudioChannelModule<In, Out> {
  return module;
}
