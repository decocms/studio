import { Page } from "@/components/page";
import { useT } from "@/i18n/use-t";
import { type Crumb, crumbLabel } from "./schema-form-breadcrumb";

/** The route keeps its identity; the mounted editor contributes its selection. */
export function BlockBreadcrumbs({
  crumbs,
  onSelect,
  onSelectRoot,
}: {
  crumbs: readonly Crumb[];
  onSelect: (index: number) => void;
  onSelectRoot?: () => void;
}) {
  const t = useT();
  const current = crumbs.at(-1);
  if (current === undefined) return null;
  return (
    <>
      <Page.Breadcrumbs
        items={[
          {
            key: "site-editor",
            label: t("sidebar.projectNav.siteEditor"),
            onClick: onSelectRoot,
          },
          ...crumbs.slice(0, -1).map((crumb, index) => ({
            key: `block-${index}`,
            label: crumbLabel(crumb),
            onClick: () => onSelect(index),
          })),
        ]}
      />
      <Page.Title>{crumbLabel(current)}</Page.Title>
    </>
  );
}
