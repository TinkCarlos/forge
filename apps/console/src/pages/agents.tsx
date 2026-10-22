import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { versionLabel } from "@/lib/format";
import { useResource } from "@/lib/use-resource";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, Pager, SkeletonRows } from "@/components/ui/data-state";
import { RowMenu } from "@/components/ui/row-menu";
import { StatusPill } from "@/components/ui/status-pill";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

type Agent = {
  id: string;
  key: string;
  name: string;
  description?: string;
  status: string;
  apiEnabled: boolean;
  publishedVersion: number | null;
  draftVersion: { id: string; version: number } | null;
};

type Pending =
  | { kind: "publish"; agent: Agent; draft: { id: string; version: number } }
  | { kind: "close-api"; agent: Agent }
  | null;

const TABS = [
  { id: "all", label: "全部" },
  { id: "draft", label: "有待发布草稿" },
  { id: "api", label: "已开放 API" },
] as const;
const PAGE = 20;
const loadAgents = () => api<{ items: Agent[] }>("/admin/api/agents").then((r) => r.items ?? []);

export function AgentsPage() {
  const toast = useToast();
  const { data, error, loading, reload } = useResource(loadAgents);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("all");
  const [page, setPage] = useState(1);
  const [pending, setPending] = useState<Pending>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data ?? []).filter((a) => {
      if (tab === "draft" && !a.draftVersion) return false;
      if (tab === "api" && !a.apiEnabled) return false;
      return !q || a.name.toLowerCase().includes(q) || a.key.toLowerCase().includes(q);
    });
  }, [data, query, tab]);
  const visible = rows.slice((page - 1) * PAGE, page * PAGE);

  const fail = (err: unknown) => {
    const e = err as ApiError;
    toast.error(e.message, e.code);
    throw err;
  };

  async function publish(agent: Agent) {
    // 发布前实时确认草稿还在（列表可能已过期）
    try {
      const detail = await api<{ versions?: { id: string; version: number; status: string }[] }>(`/admin/api/agents/${agent.id}`);
      const draft = detail.versions?.find((v) => v.status === "draft");
      if (!draft) {
        toast.error("没有待发布的草稿，可能已被其他人发布，列表已刷新");
        void reload();
        return;
      }
      setPending({ kind: "publish", agent, draft });
    } catch (err) {
      const e = err as ApiError;
      toast.error(e.message, e.code);
    }
  }

  async function setApi(agent: Agent, enabled: boolean) {
    try {
      await api(`/admin/api/agents/${agent.id}`, { method: "PATCH", body: { apiEnabled: enabled } });
      toast.success(enabled ? `已开放「${agent.name}」的 API` : `已关闭「${agent.name}」的 API`);
      void reload();
    } catch (err) {
      fail(err);
    }
  }

  return (
    <div className="rounded-card border border-border bg-card">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <div className="flex gap-1">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => { setTab(t.id); setPage(1); }} className={cn("h-8 rounded-control px-3 text-sm font-medium", tab === t.id ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}>
              {t.label}
            </button>
          ))}
        </div>
        <label className="relative ml-auto">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 h-4 w-4 text-muted-foreground" />
          <input value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} placeholder="搜索名称或 Key" aria-label="搜索 Agent" className="h-9 w-60 rounded-control border border-border bg-card pr-3 pl-8 text-sm outline-none focus:ring-4 focus:ring-ring" />
        </label>
      </div>

      {error ? (
        <ErrorState message={error.message} code={(error as ApiError).code} onRetry={reload} />
      ) : !loading && rows.length === 0 ? (
        data?.length ? <EmptyState title="没有符合条件的 Agent" hint="换个关键词或筛选条件试试。" /> : <EmptyState title="还没有 Agent" hint="新建 Agent 目前仍在旧版控制台操作，默认使用离线 Mock 模型即可运行。" action={<Button variant="outline" size="sm" onClick={() => (location.href = "/#agents")}>去旧版新建</Button>} />
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="h-10 text-left text-xs text-muted-foreground">
              <th className="px-4 font-medium">名称</th>
              <th className="px-4 font-medium">线上版本</th>
              <th className="px-4 font-medium">开放 API</th>
              <th className="px-4 font-medium">状态</th>
              <th className="w-[220px] px-4 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && !data ? <SkeletonRows cols={5} /> : visible.map((agent) => (
              <tr key={agent.id} className="h-11 border-t border-border hover:bg-muted/50">
                <td className="px-4 py-2">
                  <div className="font-medium">{agent.name}</div>
                  <div className="font-mono text-xs text-muted-foreground">{agent.key}</div>
                </td>
                <td className="px-4">
                  {versionLabel(agent.publishedVersion)}
                  {agent.draftVersion && <span className="ml-2 text-xs text-warning">草稿 {versionLabel(agent.draftVersion.version)}</span>}
                </td>
                <td className="px-4">{agent.apiEnabled ? <StatusPill status="enabled" label="已开放" /> : <StatusPill status="cancelled" label="未开放" />}</td>
                <td className="px-4"><StatusPill status={agent.status} /></td>
                <td className="px-4">
                  <div className="flex items-center justify-end gap-1">
                    {agent.draftVersion ? (
                      <Button size="sm" variant="outline" onClick={() => publish(agent)}>发布 {versionLabel(agent.draftVersion.version)}</Button>
                    ) : null}
                    <RowMenu
                      label={`「${agent.name}」更多操作`}
                      items={[
                        agent.apiEnabled
                          ? { label: "关闭开放 API", destructive: true, onSelect: () => setPending({ kind: "close-api", agent }) }
                          : { label: "开放 API", onSelect: () => void setApi(agent, true) },
                        { label: "在旧版中查看详情", onSelect: () => (location.href = "/#agents") },
                      ]}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Pager page={page} total={rows.length} size={PAGE} onPage={setPage} />

      <AlertDialog
        open={pending?.kind === "publish"}
        title={pending?.kind === "publish" ? `发布「${pending.agent.name}」${versionLabel(pending.draft.version)}` : ""}
        confirmLabel="确认发布"
        onClose={() => setPending(null)}
        onConfirm={async () => {
          if (pending?.kind !== "publish") return;
          try {
            await api(`/admin/api/agents/${pending.agent.id}/publish`, { method: "POST", body: { versionId: pending.draft.id } });
            toast.success(`已发布「${pending.agent.name}」${versionLabel(pending.draft.version)}`);
            void reload();
          } catch (err) {
            fail(err);
          }
        }}
      >
        {pending?.kind === "publish" && (
          <>发布后开放 API 和定时任务会立即改用 {versionLabel(pending.draft.version)}，{pending.agent.publishedVersion ? `当前线上版本是 ${versionLabel(pending.agent.publishedVersion)}` : "这个 Agent 目前还没有线上版本"}。</>
        )}
      </AlertDialog>

      <AlertDialog
        open={pending?.kind === "close-api"}
        destructive
        title={pending ? `关闭「${pending.agent.name}」的开放 API` : ""}
        confirmLabel="确认关闭"
        onClose={() => setPending(null)}
        onConfirm={async () => {
          if (pending?.kind === "close-api") await setApi(pending.agent, false);
        }}
      >
        关闭后外部应用无法再发起新调用；已在运行的任务会继续完成，结果仍可查询。之后可以随时重新开放。
      </AlertDialog>
    </div>
  );
}
