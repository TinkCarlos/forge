import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

export type MenuItem = { label: string; onSelect: () => void; destructive?: boolean };

/** 每行一个主操作，其余进「⋯」（DESIGN.md §6）。方向键切换、Home/End 跳首尾、Esc 关闭并把焦点还给触发按钮。 */
export function RowMenu({ items, label }: { items: MenuItem[]; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    itemRefs.current[0]?.focus();
    const outside = (event: MouseEvent) => !ref.current?.contains(event.target as Node) && setOpen(false);
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);

  const onMenuKey = (event: KeyboardEvent) => {
    const list = itemRefs.current.filter(Boolean) as HTMLButtonElement[];
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    const move = (next: number) => { event.preventDefault(); list[(next + list.length) % list.length]?.focus(); };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(list.length - 1);
    else if (event.key === "Escape") { event.preventDefault(); close(true); }
    else if (event.key === "Tab") setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === "ArrowDown" && !open) { e.preventDefault(); setOpen(true); } }}
        className="grid h-8 w-8 place-items-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div role="menu" aria-label={label} onKeyDown={onMenuKey} className="absolute right-0 z-30 mt-1 min-w-[148px] rounded-card border border-border bg-card p-1 shadow-lg">
          {items.map((item, i) => (
            <button
              key={item.label}
              ref={(el) => { itemRefs.current[i] = el; }}
              role="menuitem"
              tabIndex={-1}
              onClick={() => { close(true); item.onSelect(); }}
              className={cn("flex h-8 w-full items-center rounded-control px-3 text-left text-sm outline-none hover:bg-muted focus:bg-muted", item.destructive && "text-destructive")}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
