import { cn } from "@/lib/utils"

export interface SwitchProps {
  checked: boolean
  onCheckedChange(checked: boolean): void
  offLabel: string
  onLabel: string
  "aria-label": string
  disabled?: boolean
}

export function Switch({
  checked,
  onCheckedChange,
  offLabel,
  onLabel,
  disabled,
  "aria-label": ariaLabel,
}: SwitchProps) {
  return (
    <span data-slot="switch-group" className="inline-flex items-center gap-2 text-sm">
      <span className={cn(!checked ? "text-foreground" : "text-muted-foreground")}>
        {offLabel}
      </span>
      <button
        type="button"
        role="switch"
        data-slot="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className="relative inline-flex h-5 w-10 shrink-0 items-center rounded bg-muted outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span
          className={cn(
            "pointer-events-none block h-4 w-4 rounded bg-primary transition-transform",
            checked ? "translate-x-[22px]" : "translate-x-[2px]"
          )}
        />
      </button>
      <span className={cn(checked ? "text-foreground" : "text-muted-foreground")}>
        {onLabel}
      </span>
    </span>
  )
}
