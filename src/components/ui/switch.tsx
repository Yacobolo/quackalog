import type * as React from "react";

import { cn } from "@/lib/utils";

export type SwitchProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
};

export function Switch({ checked, onCheckedChange, className, ...props }: SwitchProps): React.ReactElement {
  return (
    <button
      aria-checked={checked}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent bg-track transition-colors hover:bg-track-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-55 data-[state=checked]:bg-track-checked",
        className,
      )}
      data-state={checked ? "checked" : "unchecked"}
      role="switch"
      type="button"
      onClick={() => onCheckedChange(!checked)}
      {...props}
    >
      <span
        className="pointer-events-none block size-4 rounded-full border border-knob-border bg-background shadow-sm transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0 data-[state=checked]:bg-knob-checked data-[state=checked]:border-knob-checked"
        data-state={checked ? "checked" : "unchecked"}
      />
    </button>
  );
}
