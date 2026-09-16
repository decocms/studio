import { Page } from "@/components/page";
import { type Crumb, crumbLabel } from "./schema-form-breadcrumb";

/** Editors own selections; Page owns the route, collapse policy, and current item. */
export function BlockBreadcrumbs({
  crumbs,
  onSelect,
  onSelectRoot,
}: {
  crumbs: readonly Crumb[];
  onSelect: (index: number) => void;
  onSelectRoot?: () => void;
}) {
  return (
    <Page.Breadcrumbs
      after="page"
      parent={{ onSelect: onSelectRoot ?? (() => onSelect(0)) }}
      items={crumbs.map((crumb, index) => ({
        key: `block-${index}`,
        label: crumbLabel(crumb),
        onSelect: () => onSelect(index),
      }))}
    />
  );
}
