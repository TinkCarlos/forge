import { Activity, Bot, CalendarClock, KeyRound, LayoutDashboard, Package, Plug, ShieldCheck, Sparkles, Users, Wrench, Cpu, Fingerprint } from "lucide-react";
import type { ComponentType } from "react";
import { Button } from "@/components/ui/button";

type NavItem = { id: string; label: string; icon: ComponentType<{ className?: string }> };
const nav: { label: string; items: NavItem[] }[] = [
  { label: "概览", items: [{ id: "dashboard", label: "总览", icon: LayoutDashboard }] },
  { label: "构建", items: [
    { id: "agents", label: "Agents", icon: Bot },
    { id: "models", label: "模型", icon: Cpu },
    { id: "mcp", label: "MCP 服务", icon: Plug },
    { id: "skills", label: "Skills", icon: Sparkles },
    { id: "tools", label: "工具源", icon: Wrench },
    { id: "packages", label: "能力包", icon: Package },
  ] },
  { label: "运行", items: [
    { id: "runs", label: "运行中心", icon: Activity },
    { id: "approvals", label: "审批中心", icon: ShieldCheck },
    { id: "schedules", label: "定时任务", icon: CalendarClock },
  ] },
  { label: "开放平台", items: [{ id: "apps", label: "应用与密钥", icon: KeyRound }] },
  { label: "治理", items: [
    { id: "users", label: "用户与权限", icon: Users },
    { id: "sso", label: "SSO / Connector", icon: Fingerprint },
  ] },
];

// 骨架：只有布局与 token，页面逐个迁移，旧版 public/ 继续可用。
export function App() {
  const active = "dashboard";
  return (
    <div className="grid h-full grid-cols-[236px_1fr]">
      <aside className="flex flex-col gap-4 bg-sidebar px-3 py-4 text-sidebar-foreground">
        <div className="flex items-center gap-2 px-2 text-lg font-semibold text-white">
          <span className="grid h-7 w-7 place-items-center rounded-control bg-primary text-sm">F</span>Forge
        </div>
        <nav className="flex flex-1 flex-col gap-1 overflow-auto">
          {nav.map((group) => (
            <div key={group.label} className="flex flex-col gap-1">
              <div className="mx-2 mt-3 text-xs text-muted-foreground">{group.label}</div>
              {group.items.map(({ id, label, icon: Icon }) => (
                <a key={id} href={`#${id}`} className={`flex h-9 items-center gap-2 rounded-control px-2 text-sm font-medium hover:bg-sidebar-hover hover:text-white ${id === active ? "bg-primary/20 text-white" : ""}`}>
                  <Icon className="h-4 w-4" />{label}
                </a>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <main className="min-w-0">
        <header className="flex h-14 items-center justify-between border-b border-border bg-card px-8">
          <div className="text-sm text-muted-foreground">概览 / <span className="text-foreground">总览</span></div>
          <Button variant="outline" size="sm">刷新</Button>
        </header>
        <section className="p-8">
          <div className="rounded-card border border-border bg-card p-6">
            <h1 className="text-xl font-semibold">新控制台骨架</h1>
            <p className="mt-2 text-sm text-muted-foreground">页面按 DESIGN.md 逐个迁移，旧版控制台仍在根路径可用。</p>
          </div>
        </section>
      </main>
    </div>
  );
}
