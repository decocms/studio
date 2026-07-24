import { useT } from "@/i18n/use-t.ts";
import { Lock01, ReverseLeft, SlashCircle01 } from "@untitledui/icons";

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

/**
 * Data-safety reassurances pinned to the bottom of the connect modal's right
 * panel. Every claim here is deliberately conservative and verifiable against
 * the Terms + Privacy Policy: connections can be revoked at any time (Privacy
 * §7), data is encrypted in transit and tokens at rest (Privacy §11), and
 * Customer Content is never sold (Terms/Privacy §6). We intentionally do NOT
 * claim "read-only" — agents open PRs and take actions, so that would overstate
 * the guarantee. Rendered over the photo + scrim, so all text is white.
 */
export function ConnectTrustSignals() {
  const t = useT();
  const items = [
    {
      Icon: ReverseLeft,
      label: t("routes.commerceOnboarding.connectModal.trustRevoke"),
    },
    {
      Icon: Lock01,
      label: t("routes.commerceOnboarding.connectModal.trustEncrypted"),
    },
    {
      Icon: SlashCircle01,
      label: t("routes.commerceOnboarding.connectModal.trustNeverSold"),
    },
  ];
  return (
    <div className="relative flex flex-col gap-2.5 text-white">
      <div className="h-px w-full bg-white/15" />
      <ul className="mt-1 flex flex-col gap-2.5">
        {items.map(({ Icon, label }) => (
          <li
            key={label}
            className="flex items-center gap-2.5 text-[13px] leading-tight text-white/70"
          >
            <Icon className="size-4 shrink-0 opacity-85" />
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}
