import type * as React from "react";

import { cn } from "@/lib/utils";

export type TooltipProps = React.HTMLAttributes<HTMLSpanElement> & {
  label: string;
};

export function Tooltip({ children, className, label, ...props }: TooltipProps): React.ReactElement {
  return (
    <span aria-label={label} className={cn("inline-flex", className)} title={label} {...props}>
      {children}
    </span>
  );
}
