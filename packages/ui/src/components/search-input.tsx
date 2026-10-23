import { SearchMd } from "@untitledui/icons";
import type * as React from "react";

import { InputGroup, InputGroupAddon, InputGroupInput } from "./input.tsx";
import { Spinner } from "./spinner.tsx";

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  className?: string;
  isSearching?: boolean;
  disabled?: boolean;
}

/** A search field: the glass, or a spinner while results load. */
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
    <InputGroup size="sm" className={className}>
      <InputGroupAddon className="pr-0">
        {isSearching ? <Spinner className="size-4" /> : <SearchMd />}
      </InputGroupAddon>
      <InputGroupInput
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled}
      />
    </InputGroup>
  );
}

export { SearchInput };
export type { SearchInputProps };
