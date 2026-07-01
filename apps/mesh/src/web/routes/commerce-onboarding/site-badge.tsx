/**
 * Brand row for the commerce onboarding login screen:
 * deco logo / site favicon + domain. Rendered when a `siteUrl` query param
 * is present. `host` must be a clean hostname (e.g. "fila.com.br").
 */
export function SiteBadge({ host }: { host: string }) {
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${host}&sz=128`;

  return (
    <div className="flex items-center gap-3">
      <img
        src="/logos/deco logo.svg"
        alt="Deco"
        className="h-7 w-7 dark:hidden"
      />
      <img
        src="/logos/deco logo negative.svg"
        alt="Deco"
        className="h-7 w-7 hidden dark:block"
      />
      <div className="h-6 w-px rotate-12 bg-border" aria-hidden="true" />
      <div className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-white">
        <img src={faviconUrl} alt="" className="h-5 w-5" loading="lazy" />
      </div>
      <span className="text-lg font-medium text-foreground">{host}</span>
    </div>
  );
}
