/** Visual divider between org-pinned and personal agent groups in the sidebar. */
export function AgentGroupSectionSeparator({
  collapsed = false,
}: {
  collapsed?: boolean;
}) {
  if (collapsed) {
    return (
      <div
        role="separator"
        aria-orientation="horizontal"
        className="mx-auto my-1 h-px w-6 shrink-0 bg-border"
      />
    );
  }

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      className="my-1.5 h-px w-full shrink-0 bg-border"
    />
  );
}
