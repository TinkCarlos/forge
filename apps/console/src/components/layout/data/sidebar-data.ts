import {
  Activity,
  Bot,
  CalendarClock,
  MessagesSquare,
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
import { LEGACY_PAGE_PERMISSIONS, ROUTE_PERMISSIONS } from '../../../lib/permissions'
import { type NavLink, type SidebarData } from '../types'

type LegacyPage = keyof typeof LEGACY_PAGE_PERMISSIONS
type Page = keyof typeof ROUTE_PERMISSIONS

/** 跳旧版控制台的入口：权限按 LEGACY_PAGE_PERMISSIONS，没有权限的入口不显示（K-29）。 */
const legacy = (id: LegacyPage, title: string, icon: NavLink['icon']): NavLink => ({
  title,
  url: `/#${id}`,
  external: true,
  icon,
  ...(id === 'users' ? { anyPermissions: ['user.view', 'role.view'] } : { permission: LEGACY_PAGE_PERMISSIONS[id] }),
})

/** 新版页面入口：权限与路由守卫共用 ROUTE_PERMISSIONS。以后加「审计」入口用 page('/audit', ...)，自动要求 audit.view。 */
export const page = (url: Page, title: string, icon: NavLink['icon']): NavLink => ({
  title,
  url,
  icon,
  permission: ROUTE_PERMISSIONS[url],
})

export const sidebarData: SidebarData = {
  navGroups: [
    { title: '概览', items: [legacy('dashboard', '总览', LayoutDashboard)] },
    {
      title: '构建',
      items: [
        page('/agents', 'Agents', Bot),
        legacy('models', '模型', Cpu),
        legacy('mcp', 'MCP 服务', Plug),
        legacy('skills', 'Skills', Sparkles),
        legacy('tools', '工具源', Wrench),
        legacy('packages', '能力包', Package),
      ],
    },
    {
      title: '运行',
      items: [page('/jobs', 'Job 管理', CalendarClock), page('/messages', '消息管理', MessagesSquare), legacy('runs', '运行中心', Activity), page('/approvals', '审批中心', ShieldCheck), legacy('schedules', '定时任务', CalendarClock)],
    },
    { title: '开放平台', items: [legacy('apps', '应用与密钥', KeyRound)] },
    {
      title: '治理',
      items: [legacy('users', '账号与权限', Users), legacy('audit', '操作日志', Activity), legacy('secrets', '凭据', KeyRound), legacy('sso', 'SSO / Connector', Fingerprint)],
    },
  ],
}
