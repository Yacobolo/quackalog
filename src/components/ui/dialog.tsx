import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type DialogProps = {
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function Dialog({ children, open, onOpenChange }: DialogProps): React.ReactElement | null {
  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onOpenChange(false);
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onOpenChange, open]);

  if (!open) {
    return null;
  }

  return createPortal(children, document.body);
}

export type DialogContentProps = {
  children: ReactNode;
  className?: string;
  title: string;
  onOpenChange: (open: boolean) => void;
};

export function DialogContent({
  children,
  className,
  title,
  onOpenChange,
}: DialogContentProps): React.ReactElement {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-overlay-backdrop p-4 backdrop-blur-sm">
      <button
        aria-label="Close connection dialog"
        className="absolute inset-0 cursor-default"
        type="button"
        onClick={() => onOpenChange(false)}
      />
      <section
        aria-label={title}
        aria-modal="true"
        className={cn(
          "relative max-h-[min(640px,calc(100vh-2rem))] w-full max-w-lg overflow-auto rounded-lg border border-border bg-popover text-popover-foreground shadow-xl",
          className,
        )}
        role="dialog"
      >
        <Button
          aria-label="Close connection dialog"
          className="absolute right-3 top-3"
          size="icon"
          type="button"
          variant="quiet"
          onClick={() => onOpenChange(false)}
        >
          <X />
        </Button>
        {children}
      </section>
    </div>
  );
}
