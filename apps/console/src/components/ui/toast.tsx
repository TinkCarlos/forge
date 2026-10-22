import { CheckCircle2, X, XCircle } from "lucide-react";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type Toast = { id: number; kind: "success" | "error"; message: string; code?: string };
type Api = { success: (message: string) => void; error: (message: string, code?: string) => void };

const ToastContext = createContext<Api | null>(null);

/** DESIGN.md §9：成功 3 秒自动消失；错误常驻，带错误码，手动关闭。 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setItems((list) => list.filter((t) => t.id !== id)), []);
  const push = useCallback((toast: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setItems((list) => [...list.slice(-3), { ...toast, id }]);
    if (toast.kind === "success") setTimeout(() => dismiss(id), 3000);
  }, [dismiss]);
  const api: Api = {
    success: (message) => push({ kind: "success", message }),
    error: (message, code) => push({ kind: "error", message, code }),
  };
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="fixed right-6 bottom-6 z-50 flex w-[360px] flex-col gap-2" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} role={t.kind === "error" ? "alert" : "status"} className="flex items-start gap-3 rounded-card border border-border bg-card p-3 text-sm shadow-lg">
            {t.kind === "success" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />}
            <div className="min-w-0 flex-1">
              <div>{t.message}</div>
              {t.code && <div className="mt-0.5 font-mono text-xs text-muted-foreground">错误码 {t.code}</div>}
            </div>
            {t.kind === "error" && (
              <button aria-label="关闭提示" className="text-muted-foreground hover:text-foreground" onClick={() => dismiss(t.id)}>
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx;
}
