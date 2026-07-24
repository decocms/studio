import { SearchMd, Loading01 } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";

interface CollectionSearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  className?: string;
  /** Show a subtle loading spinner when searching in background */
  isSearching?: boolean;
  disabled?: boolean;
}

/**
 * CollectionSearch - Search bar for collection pages
 *
 * Layout from Figma:
 * - Full width with border-bottom
 * - Height: 48px
 * - Padding: 16px horizontal, 14px vertical
 * - Icon: search-md (16px)
 * - Input: text-sm, muted-foreground placeholder
 */
export function CollectionSearch({
  value,
  onChange,
  placeholder = "Search...",
  onKeyDown,
  className,
  isSearching,
  disabled,
}: CollectionSearchProps) {
  return (
    <div
      className={cn("shrink-0 w-full border-b border-border h-12", className)}
    >
      <label
        className={cn(
          "flex items-center gap-2.5 h-12 px-4",
          disabled ? "cursor-not-allowed opacity-50" : "cursor-text",
        )}
      >
        {isSearching ? (
          <Loading01
            size={16}
            className="animate-spin text-muted-foreground shrink-0"
          />
        ) : (
          <SearchMd size={16} className="text-muted-foreground shrink-0" />
        )}
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          className="flex-1 min-w-0 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/50 outline-none"
        />
      </label>
    </div>
  );
}
