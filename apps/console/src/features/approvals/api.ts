import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api'

export type Approval = {
  id: string
  run_id: string
  agent_name: string
  risk_level: string
  expires_at: string
  created_at: string
  tool_name?: string | null
  args_preview?: string | null
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
