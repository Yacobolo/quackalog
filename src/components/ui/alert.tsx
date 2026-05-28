import type * as React from "react";

import { cn } from "@/lib/utils";

type AlertVariant = "info" | "success" | "warning" | "error";

const variantClass: Record<AlertVariant, string> = {
  info: "border-border bg-card text-card-foreground",
  success: "border-primary/20 bg-primary/10 text-foreground",
  warning: "border-border bg-muted text-foreground",
  error: "border-destructive/50 bg-card text-destructive",
};

export type AlertProps = React.HTMLAttributes<HTMLDivElement> & {
  variant?: AlertVariant;
};

export function Alert({ className, variant = "info", ...props }: AlertProps): React.ReactElement {
  return (
    <div
      className={cn("rounded-md border px-3 py-2 text-sm leading-5", variantClass[variant], className)}
      role={variant === "error" ? "alert" : "status"}
      {...props}
    />
  );
}
