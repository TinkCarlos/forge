import {
  Activity,
  Bot,
  CalendarClock,
  Cpu,
  Fingerprint,
  KeyRound,
  LayoutDashboard,
  Package,
  Plug,
  ShieldCheck,
  Sparkles,
  Users,
  Wrench,
} from 'lucide-react'
import { type SidebarData } from '../types'

const legacy = (id: string) => `/#${id}`

export const sidebarData: SidebarData = {
  navGroups: [
    { title: '概览', items: [{ title: '总览', url: legacy('dashboard'), external: true, icon: LayoutDashboard }] },
    {
      title: '构建',
      items: [
        { title: 'Agents', url: '/agents', icon: Bot },
        { title: '模型', url: legacy('models'), external: true, icon: Cpu },
        { title: 'MCP 服务', url: legacy('mcp'), external: true, icon: Plug },
        { title: 'Skills', url: legacy('skills'), external: true, icon: Sparkles },
        { title: '工具源', url: legacy('tools'), external: true, icon: Wrench },
        { title: '能力包', url: legacy('packages'), external: true, icon: Package },
      ],
    },
    {
      title: '运行',
      items: [
        { title: '运行中心', url: legacy('runs'), external: true, icon: Activity },
        { title: '审批中心', url: '/approvals', icon: ShieldCheck },
        { title: '定时任务', url: legacy('schedules'), external: true, icon: CalendarClock },
      ],
    },
    { title: '开放平台', items: [{ title: '应用与密钥', url: legacy('apps'), external: true, icon: KeyRound }] },
    {
      title: '治理',
      items: [
        { title: '用户与权限', url: legacy('users'), external: true, icon: Users },
        { title: 'SSO / Connector', url: legacy('sso'), external: true, icon: Fingerprint },
      ],
    },
  ],
}
