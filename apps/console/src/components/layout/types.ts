import { type LinkProps } from '@tanstack/react-router'
import { type Permission } from '@/lib/permissions'

type BaseNavItem = {
  title: string
  badge?: string
  icon?: React.ElementType
  /** K-29：没有这项权限时侧栏不显示该入口（与后端该页面列表接口要求的权限一致）。 */
  permission?: Permission
  anyPermissions?: readonly Permission[]
}

/** external：还没迁到新版的页面，跳回旧控制台（整页跳转）。 */
type NavLink = BaseNavItem & {
  url: LinkProps['to'] | (string & {})
  external?: boolean
  items?: never
}

type NavCollapsible = BaseNavItem & {
  items: (BaseNavItem & { url: LinkProps['to'] | (string & {}); external?: boolean })[]
  url?: never
}

type NavItem = NavCollapsible | NavLink

type NavGroup = {
  title: string
  items: NavItem[]
}

type SidebarData = {
  navGroups: NavGroup[]
}

export type { SidebarData, NavGroup, NavItem, NavCollapsible, NavLink }
