import { type ErrorComponentProps } from '@tanstack/react-router'
import { isForbidden } from '@/lib/permissions'
import { ForbiddenError } from './forbidden-error'
import { GeneralError } from './general-error'

/** 登录后各页面的 errorComponent：403 显示 ForbiddenError，其他错误沿用 GeneralError。 */
export function RouteError({ error }: ErrorComponentProps) {
  return isForbidden(error) ? <ForbiddenError /> : <GeneralError />
}
