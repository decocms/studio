export function EmptyMessage({
  icon: Icon,
  title,
  description,
}: {
  icon?: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  description?: string;
}) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
      {Icon && <Icon size={24} className="text-muted-foreground/60" />}
      <div>{title}</div>
      {description && (
        <div className="text-xs text-muted-foreground/80 max-w-sm">
          {description}
        </div>
      )}
    </div>
  );
}
