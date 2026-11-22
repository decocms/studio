import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { createContext, useContext } from "react";
import { useIsMobile } from "../hooks/use-mobile.ts";
import { cn } from "../lib/utils.ts";
import * as drawer from "./drawer.tsx";
import * as dropdown from "./dropdown-menu.tsx";

const ResponsiveDropdownContext = createContext<{
  setOpen: (open: boolean) => void;
}>({ setOpen: () => {} });

const useResponsiveDropdownContext = () =>
  useContext(ResponsiveDropdownContext);

const ResponsiveDropdown = ({
  children,
  defaultOpen,
  open: openProp,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof dropdown.DropdownMenu>) => {
  const [open, setOpen] = useControllableState({
    prop: openProp,
    defaultProp: defaultOpen ?? false,
    onChange: onOpenChange,
  });

  return (
    <ResponsiveDropdownContext.Provider value={{ setOpen }}>
      <dropdown.DropdownMenu open={open} onOpenChange={setOpen} {...props}>
        <drawer.Drawer open={open} onOpenChange={setOpen} {...props}>
          {children}
        </drawer.Drawer>
      </dropdown.DropdownMenu>
    </ResponsiveDropdownContext.Provider>
  );
};

const ResponsiveDropdownContent = ({
  children,
  title,
  ...props
}: React.ComponentProps<typeof dropdown.DropdownMenuContent>) => {
  const isMobile = useIsMobile();
  const { className, ...restProps } = props;

  return isMobile ? (
    <drawer.DrawerContent {...restProps}>
      <drawer.DrawerHeader className="hidden">
        <drawer.DrawerTitle>{title}</drawer.DrawerTitle>
      </drawer.DrawerHeader>
      <div
        className={cn(
          "flex flex-col gap-(--space-xxs) p-(--space-xs) py-(--space-m)",
          className,
        )}
      >
        {children}
      </div>
    </drawer.DrawerContent>
  ) : (
    <dropdown.DropdownMenuContent {...props}>
      {children}
    </dropdown.DropdownMenuContent>
  );
};

const ResponsiveDropdownItem = ({
  children,
  ...props
}: React.ComponentProps<typeof dropdown.DropdownMenuItem>) => {
  const { setOpen } = useResponsiveDropdownContext();
  const isMobile = useIsMobile();
  const { className, ...otherProps } = props;

  return isMobile ? (
    <div
      {...(otherProps as React.HTMLAttributes<HTMLDivElement>)}
      onClick={(e) => {
        setOpen(false);
        const { onClick } = otherProps as React.HTMLAttributes<HTMLDivElement>;
        onClick?.(e);
      }}
      className={cn(
        "focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-error-transparent data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:!text-destructive [&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-default items-center gap-(--space-xs) rounded-xs px-(--space-xs) py-(--space-xxs) min-h-(--studio-control-height-sm) text-s font-regular outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:text-neutral-6 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
    >
      {children}
    </div>
  ) : (
    <dropdown.DropdownMenuItem {...props}>{children}</dropdown.DropdownMenuItem>
  );
};

const ResponsiveDropdownTrigger = ({
  children,
  ...props
}: React.ComponentProps<typeof dropdown.DropdownMenuTrigger>) => {
  const isMobile = useIsMobile();

  return isMobile ? (
    <drawer.DrawerTrigger asChild>{children}</drawer.DrawerTrigger>
  ) : (
    <dropdown.DropdownMenuTrigger {...props}>
      {children}
    </dropdown.DropdownMenuTrigger>
  );
};

const ResponsiveDropdownSeparator = ({
  className,
  ...props
}: React.ComponentProps<typeof dropdown.DropdownMenuSeparator>) => {
  const isMobile = useIsMobile();

  return isMobile ? (
    <dropdown.DropdownMenuSeparator className={cn(className)} {...props} />
  ) : (
    <dropdown.DropdownMenuSeparator className={cn(className)} {...props} />
  );
};

export {
  ResponsiveDropdown,
  ResponsiveDropdownContent,
  ResponsiveDropdownItem,
  ResponsiveDropdownSeparator,
  ResponsiveDropdownTrigger,
};
