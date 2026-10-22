import { Activity, Bot, CalendarClock, Cpu, ExternalLink, Fingerprint, KeyRound, LayoutDashboard, LogOut, Package, Plug, RotateCw, ShieldCheck, Sparkles, Users, Wrench } from "lucide-react";
import { useCallback, useEffect, useState, type ComponentType } from "react";
import { api, setSession, setUnauthorizedHandler, type Session } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ToastProvider } from "@/components/ui/toast";
import { AgentsPage } from "@/pages/agents";
import { ApprovalsPage } from "@/pages/approvals";
import { LoginPage } from "@/pages/login";
import { cn } from "@/lib/utils";

type NavItem = { id: string; label: string; icon: ComponentType<{ className?: string }>; ready?: boolean };
const NAV: { label: string; items: NavItem[] }[] = [
  { label: "概览", items: [{ id: "dashboard", label: "总览", icon: LayoutDashboard }] },
  { label: "构建", items: [
    { id: "agents", label: "Agents", icon: Bot, ready: true },
    { id: "models", label: "模型", icon: Cpu },
    { id: "mcp", label: "MCP 服务", icon: Plug },
    { id: "skills", label: "Skills", icon: Sparkles },
    { id: "tools", label: "工具源", icon: Wrench },
    { id: "packages", label: "能力包", icon: Package },
  ] },
  { label: "运行", items: [
    { id: "runs", label: "运行中心", icon: Activity },
    { id: "approvals", label: "审批中心", icon: ShieldCheck, ready: true },
    { id: "schedules", label: "定时任务", icon: CalendarClock },
  ] },
  { label: "开放平台", items: [{ id: "apps", label: "应用与密钥", icon: KeyRound }] },
  { label: "治理", items: [
    { id: "users", label: "用户与权限", icon: Users },
    { id: "sso", label: "SSO / Connector", icon: Fingerprint },
  ] },
];
const ALL = NAV.flatMap((g) => g.items.map((i) => ({ ...i, group: g.label })));

function useRoute() {
  const read = () => location.hash.replace(/^#\/?/, "") || "agents";
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

/** 每 30 秒检查 /readyz；数据库字段为 false 也算不可用。 */
function useApiHealth() {
  const [ok, setOk] = useState(true);
  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch("/readyz", { cache: "no-store" });
        const body = await res.json().catch(() => null);
        setOk(res.ok && body?.database !== false);
      } catch {
        setOk(false);
      }
    };
    void check();
    const timer = setInterval(check, 30_000);
    return () => clearInterval(timer);
  }, []);
  return ok;
}

function Shell({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const route = useRoute();
  const healthy = useApiHealth();
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const loadCount = useCallback(() => {
    api<{ items: unknown[] }>("/admin/api/approvals").then((r) => setPendingCount(r.items?.length ?? 0)).catch(() => {});
  }, []);
  useEffect(loadCount, [loadCount, refreshKey]);

  const current = ALL.find((i) => i.id === route) ?? ALL.find((i) => i.id === "agents")!;
  const user = (session.user ?? session) as { name?: string; email?: string };

  return (
    <div className="grid h-full grid-cols-[236px_1fr]">
      <aside className="flex min-h-0 flex-col gap-2 bg-sidebar px-3 py-4 text-sidebar-foreground">
        <div className="flex items-center gap-2 px-2 pb-2 text-lg font-semibold text-white">
          <span className="grid h-7 w-7 place-items-center rounded-control bg-primary text-sm">F</span>Forge
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 overflow-auto" aria-label="主导航">
          {NAV.map((group) => (
            <div key={group.label} className="flex flex-col gap-0.5">
              <div className="mx-2 mt-3 mb-1 text-xs text-slate-400">{group.label}</div>
              {group.items.map(({ id, label, icon: Icon, ready }) => (
                <a
                  key={id}
                  href={ready ? `#${id}` : `/#${id}`}
                  aria-current={id === current.id ? "page" : undefined}
                  className={cn("flex h-9 items-center gap-2 rounded-control px-2 text-sm font-medium hover:bg-sidebar-hover hover:text-white", id === current.id && "bg-sidebar-hover text-white")}
                >
                  <Icon className="h-4 w-4" />
                  <span className="flex-1">{label}</span>
                  {id === "approvals" && !!pendingCount && <span className="rounded-full bg-primary px-1.5 text-xs text-white" aria-label={`${pendingCount} 条待审批`}>{pendingCount}</span>}
                  {!ready && <ExternalLink className="h-3.5 w-3.5 opacity-50" aria-label="在旧版控制台打开" />}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="flex items-center gap-2 border-t border-white/10 px-2 pt-3 text-sm">
          <span className="min-w-0 flex-1 truncate" title={user.email}>{user.name ?? user.email ?? "已登录"}</span>
          <button aria-label="退出登录" title="退出登录" onClick={onLogout} className="rounded p-1 text-slate-300 hover:bg-sidebar-hover hover:text-white"><LogOut className="h-4 w-4" /></button>
        </div>
      </aside>
      <main className="flex min-w-0 flex-col overflow-auto">
        {!healthy && (
          <div role="alert" className="bg-destructive-soft px-8 py-2 text-sm text-destructive">API 或数据库暂时不可用，页面数据可能不是最新的。每 30 秒自动重试一次。</div>
        )}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-card px-8">
          <nav aria-label="面包屑" className="text-sm text-muted-foreground">{current.group} / <span className="text-foreground">{current.label}</span></nav>
          <Button variant="outline" size="sm" onClick={() => setRefreshKey((k) => k + 1)}><RotateCw className="h-4 w-4" />刷新</Button>
        </header>
        <section className="p-8">
          {current.id === "approvals" ? <ApprovalsPage key={refreshKey} onChanged={loadCount} /> : <AgentsPage key={refreshKey} />}
        </section>
      </main>
    </div>
  );
}

export function App() {
  const [session, setState] = useState<Session | null | undefined>(undefined);
  const update = (next: Session | null) => {
    setSession(next);
    setState(next);
  };
  useEffect(() => {
    setUnauthorizedHandler(() => update(null));
    api<Session>("/auth/session").then(update).catch(() => update(null));
  }, []);

  return (
    <ToastProvider>
      {session === undefined ? null : session ? (
        <Shell session={session} onLogout={async () => { await api("/auth/logout", { method: "POST" }).catch(() => {}); update(null); }} />
      ) : (
        <LoginPage onLogin={update} />
      )}
    </ToastProvider>
  );
}
