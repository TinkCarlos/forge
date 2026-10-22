import { cn } from "@/lib/utils";

type Tone = "success" | "info" | "warning" | "destructive" | "neutral";

// DESIGN.md §7
const TONE: Record<string, Tone> = {
  succeeded: "success", enabled: "success", active: "success", approved: "success", published: "success",
  queued: "info", running: "info", low: "info",
  waiting_approval: "warning", awaiting_approval: "warning", pending: "warning", disabled: "warning", draft: "warning", medium: "warning",
  failed: "destructive", rejected: "destructive", expired: "destructive", budget_exhausted: "destructive", high: "destructive", critical: "destructive",
  cancelled: "neutral",
};

const LABEL: Record<string, string> = {
  succeeded: "成功", active: "启用", enabled: "启用", approved: "已批准", published: "已发布",
  queued: "排队中", running: "运行中", waiting_approval: "待审批", pending: "待审批", disabled: "已停用", draft: "草稿",
  failed: "失败", rejected: "已驳回", expired: "已过期", budget_exhausted: "预算耗尽", cancelled: "已取消",
  low: "低风险", medium: "中风险", high: "高风险", critical: "严重",
};

const STYLE: Record<Tone, string> = {
  success: "bg-success-soft text-success",
  info: "bg-info-soft text-info",
  warning: "bg-warning-soft text-warning",
  destructive: "bg-destructive-soft text-destructive",
  neutral: "bg-muted text-muted-foreground",
};

export function StatusPill({ status, label }: { status: string; label?: string }) {
  const tone = TONE[status] ?? "neutral";
  return (
    <span className={cn("inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium", STYLE[tone])}>
      {status === "running" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {label ?? LABEL[status] ?? status}
    </span>
  );
}
