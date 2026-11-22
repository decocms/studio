import { SearchMd } from "@untitledui/icons";
import { Spinner } from "./spinner.tsx";
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

/** Search field with an inline icon, styled like `Input`. */
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
        "flex h-(--studio-control-height) items-center gap-(--space-xs) rounded-(--studio-control-radius) bg-[var(--studio-input-background)] px-(--space-s) text-s font-regular text-foreground shadow-(--edge)",
        "hover:shadow-[0_0_0_var(--border-s)_var(--neutral-5)] [&:has(input:focus-visible)]:[outline:var(--focus-ring-outline)] [&:has(input:focus-visible)]:outline-offset-2",
        "transition-[background-color,box-shadow,color] duration-(--motion-duration) ease-motion",
        disabled &&
          "pointer-events-none bg-neutral-3 text-neutral-6 shadow-[0_0_0_var(--border-s)_var(--neutral-4-transparent)]",
        className,
      )}
    >
      {isSearching ? (
        <Spinner className="size-4 text-muted-foreground/75 shrink-0" />
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
        className="flex-1 min-w-0 bg-transparent placeholder:text-muted-foreground outline-none"
      />
    </label>
  );
}

export { SearchInput };
export type { SearchInputProps };
