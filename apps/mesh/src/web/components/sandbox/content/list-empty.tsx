export function ListEmpty({
  hasItems,
  emptyLabel,
  emptyHint,
}: {
  hasItems: boolean;
  emptyLabel: string;
  emptyHint: string;
}) {
  return (
    <div className="px-3 py-6 text-center text-xs text-muted-foreground">
      {hasItems ? (
        "No results match your search."
      ) : (
        <>
          <div>{emptyLabel}</div>
          <div className="mt-1 text-muted-foreground/80">{emptyHint}</div>
        </>
      )}
    </div>
  );
}
