import { useAuthStore } from '@/stores/auth-store'
import { createGuard } from './permissions'

/**
 * 用在子路由的 beforeLoad 里：beforeLoad: guard('approval.view')。
 * _authenticated 的 beforeLoad 先跑，会话已经在 store 里了。没权限时抛 ForbiddenError，
 * 由该路由的 errorComponent（RouteError）在布局内渲染 403 页，侧栏照常显示。
 */
export const guard = createGuard(() => useAuthStore.getState().session)
