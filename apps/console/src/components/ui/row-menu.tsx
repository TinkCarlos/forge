import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type MenuItem = { label: string; onSelect: () => void; destructive?: boolean };

/** 每行一个主操作，其余进「⋯」（DESIGN.md §6）。 */
export function RowMenu({ items, label }: { items: MenuItem[]; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => !ref.current?.contains(event.target as Node) && setOpen(false);
    const esc = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="grid h-8 w-8 place-items-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground">
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-1 min-w-[148px] rounded-card border border-border bg-card p-1 shadow-lg">
          {items.map((item) => (
            <button key={item.label} role="menuitem" onClick={() => { setOpen(false); item.onSelect(); }} className={cn("flex h-8 w-full items-center rounded-control px-2.5 text-left text-sm hover:bg-muted", item.destructive && "text-destructive")}>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
