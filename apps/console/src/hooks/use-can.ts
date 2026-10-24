import { useMemo } from 'react'
import { useAuthStore } from '@/stores/auth-store'
import { can, permissionsOf, type Permission } from '@/lib/permissions'

/** 当前会话的权限列表（来自 /auth/session）。会话不变时返回同一个数组。 */
export function usePermissions(): string[] {
  const session = useAuthStore((s) => s.session)
  return useMemo(() => permissionsOf(session), [session])
}

/** useCan('agent.manage')：组件里判断按钮/入口是否显示。传数组表示全部都要有。 */
export function useCan(need: Permission | readonly Permission[]): boolean {
  return can(usePermissions(), need)
}
