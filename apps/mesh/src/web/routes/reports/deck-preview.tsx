// DEV-ONLY preview harness for the two report slides we changed on this branch:
//   1. Scorecard — the rival's logo is bigger per row, only where a real
//      head-to-head exists (no misleading global "vs" header).
//   2. Categorias (gauges) — a concrete, data-driven headline.
// No auth, no backend, no router: it renders the templates directly with
// representative sample props so the visual change can be eyeballed. Served by
// Vite at /deck-preview.html.
import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import type { GaugesProps, ScorecardProps } from "@/reports/deck-types";
import CategoriasVariant from "./templates/categorias-variant";
import ScorecardTemplate from "./templates/scorecard-template";
import { DECK } from "./templates/tokens";
import "../../../../index.css";
import "./reports.css";

const fav = (domain: string) =>
  `https://www.google.com/s2/favicons?sz=64&domain=${domain}`;

// Mirrors the head-to-head from the feedback screenshots (Nannai leads on
// backlinks, loses on traffic + keywords to one rival, no comparison on
// authority) — a deliberately mixed slide so the per-row rival treatment shows.
const scorecard: ScorecardProps = {
  eyebrow: "Você lidera a marca, mas perde em volume",
  headline: "Concorrentes já têm mais tráfego que você",
  annotation:
    "summervilleresort.com.br soma 1.287 palavras-chave orgânicas contra 1.172 da Nannai.",
  rivalLabel: "Concorrente líder",
  faviconUrl: fav("nannai.com.br"),
  active: true,
  dimensions: [
    { label: "Domínios de referência (backlinks)", you: "1.403", tone: "good" },
    { label: "Autoridade de domínio", you: "37", tone: "neutral" },
    {
      label: "Tráfego orgânico estimado",
      you: "23.398",
      rival: "34.096",
      rivalName: "summervilleresort.com.br",
      tone: "bad",
    },
    {
      label: "Palavras-chave orgânicas",
      you: "1.172",
      rival: "1.287",
      rivalName: "summervilleresort.com.br",
      tone: "bad",
    },
  ],
};

// The headline string is what the commerce-skills builder now produces
// deterministically (strongest area ; weakest area), replacing the old vague
// "Onde a base sustenta o crescimento e onde ela cede".
const categorias: GaugesProps = {
  eyebrow: "Notas por área",
  headline: "SEO é sua área mais forte; Performance, a mais frágil",
  annotation:
    "Nota 0 a 100 por área, ponderada pela severidade das falhas medidas nas verificações públicas.",
  active: true,
  gauges: [
    {
      label: "SEO",
      value: "82",
      status: "good",
      caption: "Bom (24 verificações)",
      ratio: 0.82,
    },
    {
      label: "Busca por IA (GEO)",
      value: "68",
      status: "warn",
      caption: "Regular (18 verificações)",
      ratio: 0.68,
    },
    {
      label: "Conversão",
      value: "74",
      status: "warn",
      caption: "Regular (21 verificações)",
      ratio: 0.74,
    },
    {
      label: "Acessibilidade",
      value: "59",
      status: "warn",
      caption: "Regular (16 verificações)",
      ratio: 0.59,
    },
    {
      label: "Segurança",
      value: "88",
      status: "good",
      caption: "Bom (12 verificações)",
      ratio: 0.88,
    },
    {
      label: "Performance",
      value: "34",
      status: "bad",
      caption: "Crítico (19 verificações)",
      ratio: 0.34,
    },
  ],
};

/** A portrait phone-sized frame — the shape a deck slide renders into. */
function SlideFrame({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <span className="text-sm font-medium text-neutral-500">{title}</span>
      <div
        className="h-[900px] w-[480px] max-w-full overflow-hidden rounded-3xl shadow-xl ring-1 ring-black/10"
        style={{ background: DECK.bg, color: DECK.ink }}
      >
        {children}
      </div>
    </div>
  );
}

function Preview() {
  return (
    <div className="min-h-screen w-full bg-neutral-100 px-6 py-10">
      <h1 className="mb-1 text-2xl font-semibold text-neutral-800">
        Report slides — changed in this branch
      </h1>
      <p className="mb-8 text-sm text-neutral-500">
        Left: competitive scorecard — the rival's logo is now bigger per row,
        only where a real head-to-head exists (no misleading global "vs"
        header). Right: "Notas por área" with the new data-driven headline.
      </p>
      <div className="flex flex-wrap gap-10">
        <SlideFrame title="Scorecard (bigger rival logo, per benchmark)">
          <ScorecardTemplate {...scorecard} />
        </SlideFrame>
        <SlideFrame title="Notas por área (concrete headline)">
          <CategoriasVariant {...categorias} />
        </SlideFrame>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <Preview />
    </StrictMode>,
  );
