// Mock data for Deco's "makes" side — CMS / content edits. Modeled on how deco
// sites Content actually works: a site is a set of PAGES, each composed of
// SECTIONS (component instances, identified by __resolveType) with editable
// PROPS. A "global section" (e.g. the announcement bar) is a saved block reused
// across pages. So a content proposal is a PROP DIFF on a section — not a banner
// image. Publishing writes the section block back (like the real SectionsEditor).
import type {
  AutonomyMode,
  IncidentState,
  ThreadMessage,
  Trigger,
} from "./mock-data";

/** The kind of prop being changed — drives how the diff renders. */
export type FieldType = "text" | "richtext" | "image" | "link" | "toggle";

/** One prop change on a section: prop `path`, current → proposed value. */
export interface FieldChange {
  label: string; // human label, e.g. "Title", "CTA label"
  path: string; // prop path, e.g. "title", "cta.text", "image.src"
  type: FieldType;
  before: string; // current value ("—" when the section/prop is new)
  after: string; // proposed value
  srcBefore?: string; // preview URL for image type, before state
  srcAfter?: string; // preview URL for image type, after state
}

/** An edit to one section on a page (or a global section). */
export interface SectionEdit {
  op: "edit" | "add";
  page: string; // "Home" (or the global block's name)
  pagePath: string; // "/" ("" for a global section)
  section: string; // section label, e.g. "Hero"
  resolveType: string; // e.g. "site/sections/Hero.tsx"
  global?: boolean; // a saved global section, reused across pages
  appliesTo?: string; // e.g. "all pages" — shown for global sections
  changes: FieldChange[];
}

/** A content proposal == a task. One or more coordinated section edits. */
export interface CmsProposal {
  id: string;
  title: string;
  state: IncidentState;
  autonomy: AutonomyMode;
  detectedAt: string;
  scope: string; // short summary, e.g. "Home · Hero" or "3 sections"
  blurb: string;
  /** The trigger event that started this task (autonomous run). */
  trigger: Trigger;
  edits: SectionEdit[];
  thread: ThreadMessage[];
}

export const CMS_PROPOSALS: CmsProposal[] = [
  {
    id: "cms-mothers-day",
    title: "Mother's Day hero on the Home page",
    state: "needs_review",
    autonomy: "propose",
    detectedAt: "Today, 08:20",
    scope: "Home · Hero section",
    blurb:
      "Mother's Day is May 11 and the Home page still runs the summer Hero. I drafted the copy, CTA and image swap.",
    trigger: {
      event: "content.calendar",
      signal:
        "Dia das Mães is May 11 (3 days out) — the Home page is still on the Verão hero.",
    },
    edits: [
      {
        op: "edit",
        page: "Home",
        pagePath: "/",
        section: "Hero",
        resolveType: "site/sections/Hero.tsx",
        changes: [
          {
            label: "Eyebrow",
            path: "eyebrow",
            type: "text",
            before: "Verão 2026",
            after: "Dia das Mães",
          },
          {
            label: "Title",
            path: "title",
            type: "text",
            before: "Sol o dia inteiro",
            after: "Para ela, com amor",
          },
          {
            label: "Subtitle",
            path: "subtitle",
            type: "text",
            before: "A nova coleção de praia já está no ar.",
            after: "Presentes que ela vai amar — até domingo.",
          },
          {
            label: "CTA label",
            path: "cta.text",
            type: "text",
            before: "Ver coleção",
            after: "Ver presentes",
          },
          {
            label: "CTA link",
            path: "cta.href",
            type: "link",
            before: "/novidades",
            after: "/presentes/dia-das-maes",
          },
          {
            label: "Background image",
            path: "image.src",
            type: "image",
            before: "hero-verao.webp",
            after: "hero-dia-das-maes.webp",
            srcBefore: "https://picsum.photos/seed/verao2026/400/250",
            srcAfter: "https://picsum.photos/seed/diasdasmaes/400/250",
          },
        ],
      },
    ],
    thread: [
      {
        id: "m1",
        speaker: "deco",
        body: "Mother's Day is Sunday May 11 and the Home page still runs the Verão hero. Gifting searches are already up ~30% week over week, so we're leaving intent on the table.",
      },
      {
        id: "m2",
        speaker: "deco",
        body: "I read the current Hero section on the Home page and drafted a gifting version — new eyebrow, headline, subtitle, CTA pointing at a curated gifts collection, and a seasonal background image. Same section, same layout; only the props change, so nothing else on the page shifts.",
      },
      {
        id: "m3",
        speaker: "deco",
        body: "Publish and I'll write the Hero block back to the Home page and schedule it to revert Sunday night. Or open it in Content and tweak any field first.",
      },
    ],
  },
  {
    id: "cms-inverno-campaign",
    title: "Inverno launch — content across the site",
    state: "needs_review",
    autonomy: "propose",
    detectedAt: "Today, 07:05",
    scope: "3 sections · Home, /inverno, global",
    blurb:
      "The Inverno collection lands next week. I prepared the Home hero, a new collection banner on /inverno, and the announcement bar.",
    trigger: {
      event: "content.calendar",
      signal:
        "Inverno collection launches next Wednesday — no launch content staged yet.",
    },
    edits: [
      {
        op: "edit",
        page: "Home",
        pagePath: "/",
        section: "Hero",
        resolveType: "site/sections/Hero.tsx",
        changes: [
          {
            label: "Eyebrow",
            path: "eyebrow",
            type: "text",
            before: "Verão 2026",
            after: "Inverno 2026",
          },
          {
            label: "Title",
            path: "title",
            type: "text",
            before: "Sol o dia inteiro",
            after: "O frio chegou primeiro",
          },
          {
            label: "CTA label",
            path: "cta.text",
            type: "text",
            before: "Ver coleção",
            after: "Explorar Inverno",
          },
          {
            label: "Background image",
            path: "image.src",
            type: "image",
            before: "hero-verao.webp",
            after: "hero-inverno.webp",
            srcBefore: "https://picsum.photos/seed/verao2026/400/250",
            srcAfter: "https://picsum.photos/seed/inverno2026/400/250",
          },
        ],
      },
      {
        op: "add",
        page: "Inverno",
        pagePath: "/inverno",
        section: "CollectionBanner",
        resolveType: "site/sections/CollectionBanner.tsx",
        changes: [
          {
            label: "Title",
            path: "title",
            type: "text",
            before: "—",
            after: "Inverno 2026",
          },
          {
            label: "Description",
            path: "description",
            type: "text",
            before: "—",
            after: "Tricôs, alfaiataria e couro — a nova coleção.",
          },
          {
            label: "Background image",
            path: "image.src",
            type: "image",
            before: "—",
            after: "banner-inverno.webp",
            srcAfter: "https://picsum.photos/seed/bannerinverno/400/250",
          },
        ],
      },
      {
        op: "edit",
        global: true,
        appliesTo: "all pages",
        page: "Announcement bar",
        pagePath: "",
        section: "AnnouncementBar",
        resolveType: "site/sections/AnnouncementBar.tsx",
        changes: [
          {
            label: "Message",
            path: "text",
            type: "text",
            before: "Frete grátis acima de R$300",
            after: "Inverno chegou — nova coleção no ar",
          },
        ],
      },
    ],
    thread: [
      {
        id: "m1",
        speaker: "deco",
        body: "The Inverno collection is set to publish next Wednesday. Last year a coordinated launch drove the season's best full-price day, so I prepared the content for the same play.",
      },
      {
        id: "m2",
        speaker: "deco",
        body: "Three changes: swap the Home Hero to the Inverno version, add a CollectionBanner section to the /inverno page, and update the global announcement bar (which shows on every page). Everything stays within existing sections — the only new thing is the /inverno banner.",
      },
      {
        id: "m3",
        speaker: "deco",
        body: "Publish and I'll write all three blocks back and schedule them for the launch window. Or tell me what to change first.",
      },
    ],
  },
  {
    id: "cms-free-shipping",
    title: "Updated the global announcement bar",
    state: "resolved",
    autonomy: "auto",
    detectedAt: "Today, 05:40",
    scope: "Announcement bar · all pages",
    blurb:
      "Low-risk and reversible, so I published it: a free-shipping-over-R$300 message in the global announcement bar.",
    trigger: {
      event: "merchandising.conversion_signal",
      signal:
        "PLP conversion dips when the free-shipping threshold isn't visible — bar is currently off.",
    },
    edits: [
      {
        op: "edit",
        global: true,
        appliesTo: "all pages",
        page: "Announcement bar",
        pagePath: "",
        section: "AnnouncementBar",
        resolveType: "site/sections/AnnouncementBar.tsx",
        changes: [
          {
            label: "Message",
            path: "text",
            type: "text",
            before: "Nova coleção de praia",
            after: "Frete grátis acima de R$300",
          },
          {
            label: "Enabled",
            path: "enabled",
            type: "toggle",
            before: "Off",
            after: "On",
          },
        ],
      },
    ],
    thread: [
      {
        id: "m1",
        speaker: "deco",
        body: "Handled this one directly — it's the kind you set me to act on (low-risk, reversible content). Conversion dips when the free-shipping threshold isn't visible, so I turned on the global announcement bar with 'Frete grátis acima de R$300'. It's a saved global section, so it now shows on every page. Published and reversible in one click — flagging it so you know.",
      },
    ],
  },
];
