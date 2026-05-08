import { useEffect, useRef, useState } from "react";
import { Logo } from "../atoms/Logo";
import { Icon } from "../atoms/Icon";
import {
  products,
  CURRENT_PRODUCT_ID,
  type Product,
} from "../../config/products";

interface ProductSwitcherProps {
  /** Which product is "this site". Defaults to decocms. */
  current?: string;
  className?: string;
}

export function ProductSwitcher({
  current = CURRENT_PRODUCT_ID,
  className = "",
}: ProductSwitcherProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Switch product docs"
        className="flex items-center gap-1.5 px-1.5 py-1 -mx-1.5 -my-1 rounded-md hover:bg-muted transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <Logo width={67} height={28} />
        <Icon
          name="ChevronDown"
          size={14}
          className={`text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Product docs"
          className="absolute left-0 top-[calc(100%+8px)] z-50 w-64 rounded-lg border border-border bg-app-background shadow-lg overflow-hidden"
        >
          <div className="px-3 py-2 border-b border-border/60">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Docs
            </span>
          </div>
          <div className="py-1">
            {products.map((product) => (
              <ProductMenuItem
                key={product.id}
                product={product}
                isCurrent={product.id === current}
                onSelect={() => setOpen(false)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface ProductMenuItemProps {
  product: Product;
  isCurrent: boolean;
  onSelect: () => void;
}

function ProductMenuItem({
  product,
  isCurrent,
  onSelect,
}: ProductMenuItemProps) {
  const sharedClasses = `flex items-center gap-3 px-3 py-2.5 text-left transition-colors ${
    isCurrent ? "bg-primary/5" : "hover:bg-muted"
  }`;

  const body = (
    <>
      <div className="flex flex-col gap-0.5 flex-1 min-w-0">
        <span
          className={`text-sm font-medium truncate ${
            isCurrent ? "text-primary" : "text-foreground"
          }`}
        >
          {product.label}
        </span>
        <span className="text-xs text-muted-foreground truncate">
          {product.description}
        </span>
      </div>
      {isCurrent ? (
        <Icon name="Check" size={16} className="text-primary shrink-0" />
      ) : product.external ? (
        <Icon
          name="ArrowUpRight"
          size={16}
          className="text-muted-foreground shrink-0"
        />
      ) : null}
    </>
  );

  if (isCurrent || !product.href) {
    return (
      <div
        role="menuitem"
        aria-current={isCurrent ? "true" : undefined}
        className={sharedClasses}
      >
        {body}
      </div>
    );
  }

  return (
    <a
      href={product.href}
      target={product.external ? "_blank" : undefined}
      rel={product.external ? "noopener noreferrer" : undefined}
      role="menuitem"
      className={sharedClasses}
      onClick={onSelect}
    >
      {body}
    </a>
  );
}
