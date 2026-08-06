import BarsTemplate from "./bars-template";
import CategoriasVariant from "./categorias-variant";
import ChecklistTemplate from "./checklist-template";
import CompetitorTemplate from "./competitor-template";
import CoverTemplate from "./cover-template";
import CtaTemplate from "./cta-template";
import GaugesTemplate from "./gauges-template";
import GeoDimensoesVariant from "./geo-dimensoes-variant";
import KeywordsTemplate from "./keywords-template";
import ListTemplate from "./list-template";
import PaginasVariant from "./paginas-variant";
import ProductsTemplate from "./products-template";
import ScorecardTemplate from "./scorecard-template";
import SeriesTemplate from "./series-template";
import StatsTemplate from "./stats-template";
import TableTemplate from "./table-template";
import ThresholdTemplate from "./threshold-template";
import type { TemplateProps } from "@decocms/shared/reports/deck-types";

/**
 * The template registry. The report builder picks a `template` per slide; this
 * switch resolves it to a renderer and adapts the slide → that template's own
 * props (its data + the shared chrome). Adding a template = add the body
 * component and one `case` here — the `never` check makes a missing case a
 * compile error.
 */
export default function SlideTemplate({
  slide,
  deck,
  active,
  onNavigate,
}: TemplateProps) {
  const t = slide.template;
  // The tiny uppercase kicker above the headline. Engine decks usually fill
  // `eyebrow` with the domain — redundant next to the deck chrome — so a
  // domain eyebrow falls back to the slide's short title (the section label).
  const kicker =
    slide.eyebrow && slide.eyebrow !== deck.meta.domain
      ? slide.eyebrow
      : slide.title;
  const common = {
    eyebrow: kicker,
    headline: slide.headline,
    annotation: slide.annotation,
    active,
  };
  // Key-targeted variants: the engine's deterministic rollup slides (stable
  // keys, PR #147) get bespoke layouts while reading the exact same template
  // data — resolved BEFORE the generic switch so the shared contract stays
  // untouched. Each guards on its template so a key collision with a different
  // body shape falls through to the generic renderer.
  // Deliberately not spread with `common`: this slide's chrome is written in
  // the dictionaries, not by the engine (see `categorias-variant.tsx`).
  if (slide.key === "categorias" && t.template === "gauges")
    return <CategoriasVariant gauges={t.gauges} active={active} />;
  if (slide.key === "geo-dimensoes" && t.template === "bars")
    return <GeoDimensoesVariant {...t} {...common} />;
  if (slide.key === "paginas" && t.template === "table")
    return <PaginasVariant {...t} {...common} />;
  switch (t.template) {
    case "cover": {
      // The cover lists the report's chapters as a clickable table of contents.
      // Source it from `meta.toc` (built server-side from the FULL deck) and
      // fall back to the loaded slides — a logged-out visitor only receives the
      // cover slide, and an empty index is exactly the wrong thing to show the
      // person we're asking to sign in. A chapter whose slide isn't loaded is
      // marked `locked`: still named, just not reachable yet.
      const MAX_CHAPTERS = 6;
      const toc =
        deck.meta.toc && deck.meta.toc.length > 0
          ? deck.meta.toc
          : deck.slides
              .filter(
                (s) =>
                  s.template.template !== "cover" &&
                  s.template.template !== "cta",
              )
              .map((s) => ({ key: s.key, title: s.title }));
      const findings = toc.slice(0, MAX_CHAPTERS).map((entry) => ({
        title: entry.title,
        slideKey: entry.key,
        locked: !deck.slides.some((s) => s.key === entry.key),
      }));
      return (
        <CoverTemplate
          {...t}
          {...common}
          findings={findings}
          faviconUrl={deck.meta.faviconUrl}
          domain={deck.meta.domain}
          brand={deck.meta.brand}
          initial={deck.meta.initial}
          areas={deck.meta.scores?.categories}
          scannedAt={deck.meta.scannedAt}
          active={active}
          onFindingClick={onNavigate}
          onStart={() =>
            onNavigate?.(findings[0]?.slideKey ?? deck.slides[1]?.key ?? "")
          }
        />
      );
    }
    case "series":
      return <SeriesTemplate {...t} {...common} />;
    case "threshold":
      return <ThresholdTemplate {...t} {...common} />;
    case "stats":
      return <StatsTemplate {...t} {...common} />;
    case "bars":
      return <BarsTemplate {...t} {...common} />;
    case "gauges":
      return <GaugesTemplate {...t} {...common} />;
    case "checklist":
      return <ChecklistTemplate {...t} {...common} />;
    case "table":
      return <TableTemplate {...t} {...common} />;
    case "list": {
      const idx = deck.slides.findIndex((s) => s.key === slide.key);
      const nextKey = deck.slides[idx + 1]?.key;
      return (
        <ListTemplate
          {...t}
          {...common}
          domain={deck.meta.domain}
          onNext={nextKey && onNavigate ? () => onNavigate(nextKey) : undefined}
        />
      );
    }
    case "keywords":
      return <KeywordsTemplate {...t} {...common} />;
    case "products":
      return <ProductsTemplate {...t} {...common} />;
    case "scorecard":
      return (
        <ScorecardTemplate
          {...t}
          {...common}
          faviconUrl={deck.meta.faviconUrl}
        />
      );
    case "competitor":
      return (
        <CompetitorTemplate
          {...t}
          {...common}
          faviconUrl={deck.meta.faviconUrl}
          domain={deck.meta.domain}
        />
      );
    case "cta":
      return (
        <CtaTemplate
          {...t}
          {...common}
          faviconUrl={deck.meta.faviconUrl}
          domain={deck.meta.domain}
          brand={deck.meta.brand}
          initial={deck.meta.initial}
          checksProbed={deck.meta.scores?.coverage.checks_probed}
          checksTotal={deck.meta.scores?.coverage.checks_total}
        />
      );
    default: {
      const _exhaustive: never = t;
      return _exhaustive;
    }
  }
}
