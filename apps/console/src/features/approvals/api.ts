import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api'

export type Approval = {
  id: string
  run_id: string
  agent_name: string
  risk_level: string
  expires_at: string | null
  created_at: string
  tool_name?: string | null
  args_preview?: string | null
  /** R9：policy = 策略审批；interrupted = Worker 接手时执行中断、转人工确认。老后端不返回，按 policy 处理。 */
  reason?: 'policy' | 'interrupted'
  /** interrupted 时是该调用已开始执行的次数；policy 时为 null。 */
  attempt?: number | null
}

type Page = { items: Approval[]; page?: number; pageSize?: number; total?: number }

export const approvalsQuery = (page: number, pageSize: number) =>
  queryOptions({
    queryKey: ['approvals', page, pageSize],
    queryFn: async () => {
      const res = await api<Page>(`/admin/api/approvals?page=${page}&pageSize=${pageSize}`)
      const items = res.items ?? []
      // 后端分页还没上线时，接口会忽略参数返回全部，前端自己切
      if (typeof res.total !== 'number') {
        return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length }
      }
      return { items, total: res.total }
    },
    placeholderData: (prev) => prev,
  })

export const approvalsCountQuery = queryOptions({
  queryKey: ['approvals', 'count'],
  queryFn: async () => {
    const res = await api<Page>('/admin/api/approvals?page=1&pageSize=1')
    return typeof res.total === 'number' ? res.total : (res.items?.length ?? 0)
  },
  refetchInterval: 30_000,
})
