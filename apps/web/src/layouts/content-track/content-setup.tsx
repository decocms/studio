/**
 * What the content track shows until the brand can be written for: what the
 * newsroom is, the loop it runs, what the brand guide still lacks, and the way
 * to it.
 */

import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, CheckCircle, Stars02 } from "@untitledui/icons";
import { BRANDS_DIR, pickBrandDir } from "@decocms/shared/brand";
import { HOME_MOUNT_PATH } from "@decocms/shared/organization/home-mount";
import type { BrandRequirement } from "@/components/sandbox/content/blog/blog-data";
import { REQUIREMENT_LABEL } from "@/components/sandbox/content/blog/generate-post-dialog";
import { useAskInChat } from "@/hooks/use-ask-in-chat";
import { useOrgFsList } from "@/hooks/use-org-fs";
import { useT } from "@/i18n/use-t.ts";
import { basename } from "@/layouts/library/location";
import { useProjectContext } from "@/sdk";
import { NEWSROOM, RoleAvatar } from "./newsroom";

const LOOP = [
  {
    title: "contentTrack.setup.loopContext",
    job: "contentTrack.setup.loopContextJob",
  },
  {
    title: "contentTrack.setup.loopHypothesis",
    job: "contentTrack.setup.loopHypothesisJob",
  },
  {
    title: "contentTrack.setup.loopExecute",
    job: "contentTrack.setup.loopExecuteJob",
  },
  {
    title: "contentTrack.setup.loopMonitor",
    job: "contentTrack.setup.loopMonitorJob",
  },
] as const;

const GUIDE = Object.keys(REQUIREMENT_LABEL) as BrandRequirement[];

/** The newsroom's own green, the same in light and dark. */
const HERO_BACKGROUND =
  "radial-gradient(120% 140% at 82% 6%, #2f7d4a 0%, #14572a 44%, #082e14 100%)";

export function ContentSetup({ missing }: { missing: BrandRequirement[] }) {
  const t = useT();
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const ask = useAskInChat();
  const listing = useOrgFsList(HOME_MOUNT_PATH, BRANDS_DIR);
  /** The folder the blog reads its brand from, as the server picks it. */
  const brand = pickBrandDir(
    org.slug,
    (listing.data ?? [])
      .filter((entry) => entry.kind === "dir")
      .map((entry) => basename(entry.path)),
  );
  const fill = () =>
    ask(
      t("library.context.fillBrandPrompt", {
        path: `${HOME_MOUNT_PATH}/${BRANDS_DIR}/${brand}/brand.md`,
        site: t("library.context.siteUnknown"),
      }),
    );
  const openBrand = () =>
    navigate({
      to: "/$org/library",
      params: { org: org.slug },
      search: { section: "brand" },
    });

  return (
    <div className="mx-auto flex w-full max-w-[820px] flex-col gap-6 pt-4">
      <section
        className="overflow-hidden rounded-[18px] px-6 py-7 text-white shadow-[0_26px_64px_-30px_rgba(8,46,20,0.65)] sm:px-[34px] sm:pt-[34px] sm:pb-[30px]"
        style={{ background: HERO_BACKGROUND }}
      >
        <span className="text-[11px] font-bold uppercase tracking-[0.07em] text-[#cdeec0]">
          {t("contentTrack.setup.eyebrow")}
        </span>
        <h2 className="mt-3 mb-3 max-w-[560px] text-[28px] font-bold leading-[1.07] tracking-[-0.015em] sm:text-[33px]">
          {t("contentTrack.setup.title")}
        </h2>
        <p className="max-w-[585px] text-[15px] leading-[1.55] text-[#dcecd3]">
          {t("contentTrack.setup.description")}
        </p>
        <ul className="my-5 flex flex-wrap gap-[11px]">
          {NEWSROOM.map(({ role, name, job }) => (
            <li
              key={role}
              className="flex items-center gap-2.5 rounded-xl border border-white/15 bg-white/10 py-[7px] pr-3.5 pl-[7px]"
            >
              <RoleAvatar role={role} />
              <span className="flex flex-col">
                <span className="text-[12.5px] font-semibold leading-[1.15] text-white">
                  {t(name)}
                </span>
                <span className="text-[10.5px] text-[#bfe0b0]">{t(job)}</span>
              </span>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-[15px]">
          <button
            type="button"
            onClick={openBrand}
            className="inline-flex items-center gap-2 rounded-[11px] bg-white px-5 py-3 text-sm font-semibold text-[#0f4a22] shadow-[0_8px_22px_-10px_rgba(0,0,0,0.5)] transition-transform hover:-translate-y-px"
          >
            <Stars02 size={16} />
            {t("contentTrack.setup.activate")}
          </button>
          <span className="text-xs text-[#bfe0b0]">
            {t("contentTrack.setup.activateHint")}
          </span>
        </div>
      </section>

      <section>
        <p className="mb-3.5 text-[12.5px] text-muted-foreground">
          {t("contentTrack.setup.loopCaption")}
        </p>
        <div className="relative mx-[12%] h-7 rounded-t-2xl border-[1.5px] border-b-0 border-dashed border-border">
          <span className="absolute -top-[9px] left-1/2 -translate-x-1/2 whitespace-nowrap bg-background px-2.5 text-[11px] text-muted-foreground">
            ↻ {t("contentTrack.setup.loopArc")}
          </span>
        </div>
        <ol className="-mt-px flex items-stretch gap-1.5">
          {LOOP.map(({ title, job }, index) => (
            <li key={title} className="flex flex-1 items-center gap-1.5">
              {index > 0 && (
                <ArrowRight
                  size={14}
                  aria-hidden
                  className="shrink-0 text-muted-foreground"
                />
              )}
              <div className="h-full flex-1 rounded-xl border border-border bg-card px-3 py-[11px]">
                <span className="grid size-[19px] place-items-center rounded-full bg-brand-lime-tint text-[11px] font-bold text-brand-green-dark dark:bg-brand/15 dark:text-brand">
                  {index + 1}
                </span>
                <span className="mt-1.5 block text-[13px] font-semibold text-foreground">
                  {t(title)}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {t(job)}
                </span>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-semibold text-foreground">
            {t("contentTrack.setup.guideTitle")}
          </h3>
          <p className="text-[12.5px] text-muted-foreground">
            {t("contentTrack.setup.guideHint")}
          </p>
        </div>
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {GUIDE.map((field) => {
            const open = missing.includes(field);
            return (
              <li
                key={field}
                className="flex items-center gap-3 px-3.5 py-2.5 text-[13px]"
              >
                {open ? (
                  <span className="size-4 shrink-0 rounded-full border-[1.5px] border-border" />
                ) : (
                  <CheckCircle size={16} className="shrink-0 text-success" />
                )}
                <span className="w-44 shrink-0 text-foreground">
                  {t(REQUIREMENT_LABEL[field])}
                </span>
                <span className="text-muted-foreground">
                  {open
                    ? `— ${t("contentTrack.setup.needsSetup")}`
                    : t("contentTrack.setup.filled")}
                </span>
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={fill}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] font-semibold text-foreground shadow-edge transition-colors hover:bg-muted"
          >
            <Stars02 size={14} />
            {t("contentTrack.setup.fill")}
          </button>
          <span className="text-xs text-muted-foreground">
            {t("contentTrack.setup.fillHint")}
          </span>
        </div>
      </section>
    </div>
  );
}
