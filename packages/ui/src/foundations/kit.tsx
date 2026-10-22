import {
  type CSSProperties,
  type ReactNode,
  Suspense,
  use,
  useState,
} from "react";

/* Building blocks of the documentation pages: a blog-like page with an
   eyebrow, a title, a lead and sections. Storybook-only; not shipped. */

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export function DocPage({
  eyebrow = "Foundations",
  title,
  lead,
  children,
}: {
  eyebrow?: string;
  title: string;
  lead?: ReactNode;
  children: ReactNode;
}) {
  return (
    <article className="text-foreground flex flex-col font-sans">
      <p className="text-subtle-foreground text-xs font-medium">{eyebrow}</p>
      <h1 className="font-display mt-2 text-5xl leading-none">{title}</h1>
      {lead && (
        <p className="text-muted-foreground mt-5 max-w-2xl text-lg leading-relaxed">
          {lead}
        </p>
      )}
      {children}
    </article>
  );
}

export function Section({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="mt-16 flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h2 id={slug(title)} className="font-display text-2xl">
          {title}
        </h2>
        {intro && (
          <p className="text-muted-foreground max-w-2xl text-sm leading-relaxed">
            {intro}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}

export function SubSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="mt-3 flex flex-col gap-3">
      <h3 id={slug(title)} className="text-sm font-medium">
        {title}
      </h3>
      {children}
    </div>
  );
}

export function Pill({ children }: { children: ReactNode }) {
  return (
    <code className="bg-muted text-foreground inline-flex w-fit rounded-full px-2 py-0.5 font-mono text-xs">
      {children}
    </code>
  );
}

export interface TokenRow {
  name: string;
  /** Value under the name: hex, px, alias. */
  meta?: string;
  description?: string;
  /** CSS for the preview swatch. */
  preview: CSSProperties;
}

export function TokenList({ rows }: { rows: TokenRow[] }) {
  return (
    <div className="surface grid grid-cols-1 overflow-hidden sm:grid-cols-2">
      {rows.map((row) => (
        <div
          key={row.name}
          className="border-border flex items-center gap-4 border-b p-4 sm:odd:border-r"
        >
          <div
            className="size-12 shrink-0 rounded-xl shadow-[inset_0_0_0_1px_var(--hairline)]"
            style={row.preview}
          />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate font-mono text-xs">{row.name}</span>
            {row.meta && (
              <span className="text-subtle-foreground text-xs">{row.meta}</span>
            )}
            {row.description && (
              <span className="text-muted-foreground text-xs">
                {row.description}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Guidelines({ items }: { items: ReactNode[] }) {
  return (
    <ul className="flex max-w-2xl list-disc flex-col gap-2 pl-5 text-sm leading-relaxed">
      {items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static copy
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

export function Code({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <pre className="bg-muted relative overflow-x-auto rounded-2xl p-5 font-mono text-xs leading-relaxed">
      <code>{children}</code>
      <button
        type="button"
        className="bg-card hairline hover:bg-accent absolute top-3 right-3 rounded-full px-3 py-1 font-sans text-xs font-medium"
        onClick={() => {
          navigator.clipboard?.writeText(children);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </pre>
  );
}

export interface NextItem {
  title: string;
  text: string;
  /** Storybook docs id, e.g. "foundations-typography--docs". */
  id: string;
  preview: ReactNode;
}

export function UpNext({ items }: { items: NextItem[] }) {
  return (
    <Section title="Up next">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {items.map((item) => (
          // `./?path=` leaves the iframe for the manager.
          <a
            key={item.id}
            href={`./?path=/docs/${item.id}`}
            target="_top"
            className="surface surface-interactive flex flex-col gap-1 p-5 no-underline"
          >
            <div className="bg-sidebar mb-3 flex h-24 items-center justify-center rounded-xl">
              {item.preview}
            </div>
            <span className="text-foreground text-sm font-medium">
              {item.title}
            </span>
            <span className="text-muted-foreground text-xs">{item.text}</span>
          </a>
        ))}
      </div>
    </Section>
  );
}

/* ---------- States matrix ---------- */

export interface MatrixProps {
  columns: string[];
  rows: { label: string; cells: ReactNode[] }[];
  /** Columns whose states were not drawn in Figma and are proposed here. */
  proposed?: string[];
}

/**
 * Variants in rows, states in columns. Force a state on a cell with the
 * pseudo-states addon: give the cell a class and list it under
 * `parameters.pseudo`.
 */
const NONE: string[] = [];

export function Matrix({ columns, rows, proposed = NONE }: MatrixProps) {
  return (
    <div className="overflow-x-auto font-sans">
      <table className="border-separate border-spacing-x-6 border-spacing-y-4">
        <thead>
          <tr>
            <th />
            {columns.map((column) => (
              <th
                key={column}
                className="text-subtle-foreground text-left text-xs font-medium whitespace-nowrap"
              >
                {column}
                {proposed.includes(column) && (
                  <span className="text-brand-purple-dark bg-brand-purple-tint ml-1.5 rounded-full px-1.5 py-px text-[0.625rem]">
                    proposed
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th className="text-muted-foreground pr-2 text-left text-xs font-medium whitespace-nowrap">
                {row.label}
              </th>
              {row.cells.map((cell, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                <td key={index} className="align-middle">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- Overview ---------- */

interface IndexEntry {
  id: string;
  title: string;
  name: string;
  type: "story" | "docs";
}

let indexPromise: Promise<IndexEntry[]> | undefined;
/** The Storybook's own index, so counts and links never go stale. */
function loadIndex() {
  indexPromise ??= fetch("./index.json")
    .then((response) => response.json())
    .then((index: { entries: Record<string, IndexEntry> }) =>
      Object.values(index.entries),
    )
    .catch(() => []);
  return indexPromise;
}

export interface IntroLayer {
  /** First segment of the story titles ("Atoms" in "Atoms/Button"). */
  title: string;
  description: string;
}

interface Chip {
  label: string;
  path: string;
}

function chipsFor(layer: string, entries: IndexEntry[]): Chip[] {
  const inLayer = entries.filter(
    (entry) =>
      entry.title.split("/")[0] === layer &&
      entry.title !== "Foundations/Overview",
  );
  const titles = [...new Set(inLayer.map((entry) => entry.title))];
  return titles.map((title) => {
    const target =
      inLayer.find((e) => e.title === title && e.type === "docs") ??
      inLayer.find((e) => e.title === title);
    return {
      label: title.split("/").slice(1).join(" / "),
      path: target ? `/${target.type}/${target.id}` : "",
    };
  });
}

function Stats({
  layers,
  countLayers,
}: {
  layers: IntroLayer[];
  countLayers: string[];
}) {
  const entries = use(loadIndex());
  const count = (layer: string) => chipsFor(layer, entries).length;
  const stats = [
    {
      label: "components",
      value: countLayers.reduce((sum, layer) => sum + count(layer), 0),
    },
    ...layers.map((l) => ({
      label: l.title.toLowerCase(),
      value: count(l.title),
    })),
  ];
  return stats.map((stat) => (
    <div
      key={stat.label}
      className="bg-brand-green-dark flex flex-[1_1_8rem] flex-col-reverse gap-1 px-5 py-4"
    >
      <dt className="text-sm text-white/60">{stat.label}</dt>
      <dd className="font-display m-0 text-3xl">{stat.value}</dd>
    </div>
  ));
}

function LayerChips({ layer }: { layer: string }) {
  const entries = use(loadIndex());
  return chipsFor(layer, entries).map((chip) => (
    <a
      key={chip.path || chip.label}
      href={`./?path=${chip.path}`}
      target="_top"
      className="bg-muted text-foreground hover:bg-brand-lime-tint hover:text-brand-green-dark rounded-full px-3 py-1.5 text-sm no-underline transition-colors"
    >
      {chip.label}
    </a>
  ));
}

export function Intro({
  layers,
  countLayers,
  hero,
  notes,
}: {
  layers: IntroLayer[];
  countLayers: string[];
  hero: ReactNode;
  notes: { title: string; text: string }[];
}) {
  return (
    <div className="text-foreground flex flex-col gap-8 font-sans">
      <header className="bg-brand-green-dark flex text-white flex-col gap-12 rounded-3xl p-10">
        {hero}
        <dl className="m-0 flex min-h-24 flex-wrap gap-px overflow-hidden rounded-2xl bg-white/12">
          <Suspense fallback={null}>
            <Stats layers={layers} countLayers={countLayers} />
          </Suspense>
        </dl>
      </header>

      <section className="flex flex-col gap-3">
        {layers.map((layer) => (
          <article
            key={layer.title}
            className="surface grid grid-cols-1 gap-6 p-6 md:grid-cols-[13rem_1fr]"
          >
            <div>
              <h2 id={slug(layer.title)} className="font-display text-xl">
                {layer.title}
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">
                {layer.description}
              </p>
            </div>
            <div className="flex flex-wrap content-start gap-2">
              <Suspense fallback={null}>
                <LayerChips layer={layer.title} />
              </Suspense>
            </div>
          </article>
        ))}
      </section>

      <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {notes.map((note) => (
          <div key={note.title} className="bg-sidebar rounded-2xl p-5">
            <h3 id={slug(note.title)} className="text-sm font-medium">
              {note.title}
            </h3>
            <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
              {note.text}
            </p>
          </div>
        ))}
      </section>
    </div>
  );
}
