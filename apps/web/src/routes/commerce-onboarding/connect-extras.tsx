import { useT } from "@/i18n/use-t.ts";

/**
 * Right-hand panel of the connect modal: a customer quote over a full-bleed
 * brand photo (Monte Carlo). The merchant just saw their diagnostic; a real
 * testimonial makes connecting feel expected. Rendered over the photo + a light
 * scrim (see {@link ConnectLayout}), so all text is white.
 *
 * NOTE: the background photo (see {@link ConnectLayout}), the avatar and the
 * quote copy are the shipped Monte Carlo testimonial — swap the CDN image URLs
 * + the `connectModal.quote` / `quoteAuthor` strings to change it.
 */
const AVATAR_SRC =
  "https://decoims.com/image?src=decocms%2F06b54678-5335-4671-b63a-e13d9e541155%2Fagataesteves.png&quality=original&fit=cover&width=160&height=160";

export function ConnectQuotePanel() {
  const t = useT();
  return (
    <div className="relative flex flex-col gap-8 text-white">
      {/* Explicit box + object-contain: this SVG reports a 300×150 intrinsic
          size and h-only + w-auto squishes it, so pin both dimensions. */}
      <img
        src="/logos/summit/monte-carlo.svg"
        alt="Monte Carlo"
        className="h-14 w-[112px] shrink-0 self-start object-contain object-left brightness-0 invert"
      />
      <blockquote className="text-lg font-medium leading-[1.45] lg:text-xl">
        “{t("routes.commerceOnboarding.connectModal.quote")}”
      </blockquote>
      <figcaption className="flex items-center gap-2.5">
        <img
          src={AVATAR_SRC}
          alt=""
          className="size-10 shrink-0 rounded-full object-cover"
          loading="lazy"
        />
        <span className="text-base font-medium">
          {t("routes.commerceOnboarding.connectModal.quoteAuthor")}
        </span>
      </figcaption>
    </div>
  );
}
