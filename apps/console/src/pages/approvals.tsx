import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { shortTime } from "@/lib/format";
import { useResource } from "@/lib/use-resource";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, ShortId, SkeletonRows } from "@/components/ui/data-state";
import { RowMenu } from "@/components/ui/row-menu";
import { StatusPill } from "@/components/ui/status-pill";
import { useToast } from "@/components/ui/toast";

type Approval = { id: string; run_id: string; agent_name: string; risk_level: string; expires_at: string; created_at: string };
type Decision = { approval: Approval; decision: "approved" | "rejected" } | null;

const loadApprovals = () => api<{ items: Approval[] }>("/admin/api/approvals").then((r) => r.items ?? []);

export function ApprovalsPage({ onChanged }: { onChanged: () => void }) {
  const toast = useToast();
  const { data, error, loading, reload } = useResource(loadApprovals);
  const [pending, setPending] = useState<Decision>(null);
  const [comment, setComment] = useState("");

  const open = (approval: Approval, decision: "approved" | "rejected") => {
    setComment("");
    setPending({ approval, decision });
  };

  return (
    <div className="rounded-card border border-border bg-card">
      {error ? (
        <ErrorState message={error.message} code={(error as ApiError).code} onRetry={reload} />
      ) : !loading && !data?.length ? (
        <EmptyState title="没有待审批的调用" hint="Agent 调用高风险工具时会暂停，等你在这里批准或驳回。" />
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="h-10 text-left text-xs text-muted-foreground">
              <th className="px-4 font-medium">Agent</th>
              <th className="px-4 font-medium">风险</th>
              <th className="px-4 font-medium">提交时间</th>
              <th className="px-4 font-medium">过期时间</th>
              <th className="w-[180px] px-4 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && !data ? <SkeletonRows cols={5} /> : data!.map((a) => {
              const created = shortTime(a.created_at);
              const expires = shortTime(a.expires_at);
              return (
                <tr key={a.id} className="h-11 border-t border-border hover:bg-muted/50">
                  <td className="px-4 py-2">
                    <div className="font-medium">{a.agent_name}</div>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">Run <ShortId id={a.run_id} /></div>
                  </td>
                  <td className="px-4"><StatusPill status={a.risk_level} /></td>
                  <td className="px-4" title={created.title}>{created.text}</td>
                  <td className="px-4" title={expires.title}>{expires.text}</td>
                  <td className="px-4">
                    <div className="flex items-center justify-end gap-1">
                      <Button size="sm" onClick={() => open(a, "approved")}>批准</Button>
                      <RowMenu
                        label={`审批 ${a.id.slice(0, 8)} 更多操作`}
                        items={[
                          { label: "驳回", destructive: true, onSelect: () => open(a, "rejected") },
                          { label: "在旧版中查看 Run", onSelect: () => (location.href = "/#runs") },
                        ]}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <AlertDialog
        open={!!pending}
        destructive={pending?.decision === "rejected"}
        title={pending ? `${pending.decision === "approved" ? "批准" : "驳回"}「${pending.approval.agent_name}」的工具调用` : ""}
        confirmLabel={pending?.decision === "approved" ? "确认批准" : "确认驳回"}
        onClose={() => setPending(null)}
        onConfirm={async () => {
          if (!pending) return;
          try {
            await api(`/admin/api/approvals/${pending.approval.id}/decide`, { method: "POST", body: { decision: pending.decision, comment } });
            toast.success(pending.decision === "approved" ? "已批准，Run 会继续执行" : "已驳回，Run 不会执行这次调用");
            void reload();
            onChanged();
          } catch (err) {
            const e = err as ApiError;
            toast.error(e.message, e.code);
            if (e.status === 409) void reload();
            throw err;
          }
        }}
      >
        <p>{pending?.decision === "approved" ? "批准后 Run 会立即继续执行这次工具调用，批准后不能撤回。" : "驳回后 Run 不会执行这次工具调用，驳回后不能撤回。"}</p>
        <label className="mt-4 block text-sm text-foreground">
          备注（可选）
          <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} className="mt-1.5 w-full resize-none rounded-control border border-border bg-card px-3 py-2 outline-none focus:ring-4 focus:ring-ring" />
        </label>
      </AlertDialog>
    </div>
  );
}
