import { SearchMd, Loading01 } from "@untitledui/icons";
import { cn } from "../lib/utils.ts";

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  className?: string;
  isSearching?: boolean;
  disabled?: boolean;
}

/**
 * SearchInput — bordered search field with icon.
 *
 * Uses the same base styling as the design-system Input (rounded-lg, border,
 * focus ring) but composes the search icon inline so consumers don't have to
 * wrap it themselves.
 */
function SearchInput({
  value,
  onChange,
  placeholder = "Search...",
  onKeyDown,
  className,
  isSearching,
  disabled,
}: SearchInputProps) {
  return (
    <label
      className={cn(
        "flex items-center gap-4 rounded-lg bg-background dark:bg-input/30 px-3 h-8 card-shadow",
        "focus-within:border-ring focus-within:ring-ring/20 focus-within:ring-[2px]",
        "transition-[color,box-shadow]",
        disabled && "pointer-events-none opacity-50",
        className,
      )}
    >
      {isSearching ? (
        <Loading01
          size={16}
          className="animate-spin text-muted-foreground/75 shrink-0"
        />
      ) : (
        <SearchMd size={16} className="text-muted-foreground/75 shrink-0" />
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
  );
}

export { SearchInput };
export type { SearchInputProps };
