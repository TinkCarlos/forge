import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "./button";

type Props = {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  /** 不可逆操作：要求输入对象名才能确认（DESIGN.md §5）。 */
  typeToConfirm?: string;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
};

/** 标题 = 动词 +「对象」；默认焦点在「取消」；Esc 关闭；确认中按钮保持宽度显示 spinner。 */
export function AlertDialog({ open, title, children, confirmLabel, destructive, typeToConfirm, onConfirm, onClose }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (!open) return;
    setTyped("");
    // 记住触发元素，关闭后把焦点还回去
    const trigger = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
      if (event.key !== "Tab" || !panelRef.current) return;
      // 焦点陷阱：Tab 只在弹窗内循环
      const nodes = panelRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), input, textarea, [tabindex]:not([tabindex='-1'])");
      if (!nodes.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (trigger?.isConnected) trigger.focus();
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;
  const blocked = typeToConfirm !== undefined && typed !== typeToConfirm;

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-overlay p-4" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div ref={panelRef} role="alertdialog" aria-modal="true" aria-labelledby="dlg-title" className="w-full max-w-[440px] rounded-dialog bg-card p-6 shadow-xl">
        <h2 id="dlg-title" className="text-lg font-semibold">{title}</h2>
        <div className="mt-2 text-sm leading-6 text-muted-foreground">{children}</div>
        {typeToConfirm !== undefined && (
          <label className="mt-4 block text-sm">
            输入 <span className="font-mono text-foreground">{typeToConfirm}</span> 确认
            <input value={typed} onChange={(e) => setTyped(e.target.value)} className="mt-2 h-9 w-full rounded-control border border-border bg-card px-3 outline-none focus:ring-4 focus:ring-ring" />
          </label>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button ref={cancelRef} variant="outline" onClick={onClose} disabled={busy}>取消</Button>
          <Button
            variant={destructive ? "destructive" : "primary"}
            loading={busy}
            disabled={blocked}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } catch {
                // 调用方负责 toast，弹窗保持打开以便重试
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
