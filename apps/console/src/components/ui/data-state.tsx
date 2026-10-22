import { Check, Copy, Inbox, RotateCw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "./button";

export function SkeletonRows({ cols, rows = 5 }: { cols: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} className="h-11 border-t border-border">
          {Array.from({ length: cols }, (_, c) => (
            <td key={c} className="px-4"><div className="h-3 animate-pulse rounded bg-muted" style={{ width: `${50 + ((r + c) % 3) * 15}%` }} /></td>
          ))}
        </tr>
      ))}
    </>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <Inbox className="h-8 w-8 text-muted-foreground" />
      <div className="font-medium">{title}</div>
      <div className="text-sm text-muted-foreground">{hint}</div>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, code, onRetry }: { message: string; code?: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <div className="font-medium text-destructive">加载失败</div>
      <div className="text-sm text-muted-foreground">{message}{code ? `（${code}）` : ""}</div>
      <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}><RotateCw className="h-4 w-4" />重试</Button>
    </div>
  );
}

/** ID 显示前 8 位 + 复制（DESIGN.md §6）。 */
export function ShortId({ id }: { id: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground" title={id}>
      {id.slice(0, 8)}
      <button
        aria-label="复制完整 ID"
        title="复制完整 ID"
        className="rounded p-0.5 hover:bg-muted hover:text-foreground"
        onClick={async () => {
          await navigator.clipboard?.writeText(id).catch(() => {});
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        }}
      >
        {done ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </span>
  );
}

export function Pager({ page, total, size, onPage }: { page: number; total: number; size: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (total <= size) return null;
  return (
    <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3 text-sm text-muted-foreground">
      共 {total} 条
      <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>上一页</Button>
      <span>{page} / {pages}</span>
      <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>下一页</Button>
    </div>
  );
}
