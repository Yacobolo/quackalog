import type * as React from "react";

import { cn } from "@/lib/utils";

type AlertVariant = "info" | "success" | "warning" | "error";

const variantClass: Record<AlertVariant, string> = {
  info: "border-info-muted/40 bg-info-muted text-info-foreground-muted",
  success: "border-success-muted/40 bg-success-muted text-success-foreground-muted",
  warning: "border-warning-muted/40 bg-warning-muted text-warning-foreground-muted",
  error: "border-danger-muted/40 bg-danger-muted text-danger",
};

export type AlertProps = React.HTMLAttributes<HTMLDivElement> & {
  variant?: AlertVariant;
};

export function Alert({ className, variant = "info", ...props }: AlertProps): React.ReactElement {
  return (
    <div
      className={cn("rounded-md border px-2.5 py-2 text-sm leading-5", variantClass[variant], className)}
      role={variant === "error" ? "alert" : "status"}
      {...props}
    />
  );
}
