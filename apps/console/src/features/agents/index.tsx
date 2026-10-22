import { useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { ExternalLink, MoreHorizontal, Plus, Rocket, SearchIcon } from 'lucide-react'
import { toast } from 'sonner'
import { api, ApiError } from '@/lib/api'
import { versionLabel } from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { DataTablePagination } from '@/components/data-table'
import { PageShell } from '@/components/layout/page-shell'
import { rowMotion } from '@/components/motion/page'
import { StatusBadge } from '@/components/status-badge'
import { SkeletonRows, TableMessage } from '@/components/table-states'

type Agent = {
  id: string
  key: string
  name: string
  description?: string
  status: string
  apiEnabled: boolean
  publishedVersion: number | null
  draftVersion: { id: string; version: number } | null
}

type Pending =
  | { kind: 'publish'; agent: Agent; draft: { id: string; version: number } }
  | { kind: 'close-api'; agent: Agent }
  | null

type Tab = 'all' | 'draft' | 'api'

const MotionRow = motion.create(TableRow)

export function Agents() {
  const qc = useQueryClient()
  const { data, error, isPending, refetch } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api<{ items: Agent[] }>('/admin/api/agents').then((r) => r.items ?? []),
  })
  const [tab, setTab] = useState<Tab>('all')
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<Pending>(null)

  const rows = useMemo(
    () => (data ?? []).filter((a) => (tab === 'draft' ? !!a.draftVersion : tab === 'api' ? a.apiEnabled : true)),
    [data, tab]
  )

  const setApi = useMutation({
    mutationFn: ({ agent, enabled }: { agent: Agent; enabled: boolean }) =>
      api(`/admin/api/agents/${agent.id}`, { method: 'PATCH', body: { apiEnabled: enabled } }),
    onSuccess: (_, { agent, enabled }) => {
      toast.success(enabled ? `已开放「${agent.name}」的 API` : `已关闭「${agent.name}」的 API`)
      setPending(null)
      void qc.invalidateQueries({ queryKey: ['agents'] })
    },
    onError: handleServerError,
  })

  const publish = useMutation({
    mutationFn: ({ agent, draft }: { agent: Agent; draft: { id: string } }) =>
      api(`/admin/api/agents/${agent.id}/publish`, { method: 'POST', body: { versionId: draft.id } }),
    onSuccess: (_, { agent }) => {
      if (pending?.kind === 'publish') toast.success(`已发布「${agent.name}」${versionLabel(pending.draft.version)}`)
      setPending(null)
      void qc.invalidateQueries({ queryKey: ['agents'] })
    },
    onError: handleServerError,
  })

  // 发布前实时确认草稿还在（列表可能已过期）
  async function askPublish(agent: Agent) {
    try {
      const detail = await api<{ versions?: { id: string; version: number; status: string }[] }>(`/admin/api/agents/${agent.id}`)
      const draft = detail.versions?.find((v) => v.status === 'draft')
      if (!draft) {
        toast.warning('没有待发布的草稿，可能已被其他人发布，列表已刷新')
        void refetch()
        return
      }
      setPending({ kind: 'publish', agent, draft })
    } catch (err) {
      handleServerError(err)
    }
  }

  const columns = useMemo<ColumnDef<Agent>[]>(
    () => [
      {
        id: 'name',
        header: '名称',
        accessorFn: (a) => `${a.name} ${a.key}`,
        cell: ({ row: { original: a } }) => (
          <div className='min-w-0'>
            <div className='truncate font-medium'>{a.name}</div>
            <div className='truncate font-mono text-xs text-muted-foreground'>{a.key}</div>
          </div>
        ),
      },
      { id: 'status', header: '状态', cell: ({ row }) => <StatusBadge status={row.original.status} /> },
      {
        id: 'version',
        header: '线上版本',
        cell: ({ row: { original: a } }) => (
          <div className='flex items-center gap-2'>
            <span className='tabular-nums'>{versionLabel(a.publishedVersion)}</span>
            {a.draftVersion && <StatusBadge status='draft' label={`草稿 ${versionLabel(a.draftVersion.version)}`} />}
          </div>
        ),
      },
      {
        id: 'api',
        header: '开放 API',
        cell: ({ row: { original: a } }) => (
          <Switch
            checked={a.apiEnabled}
            disabled={setApi.isPending && setApi.variables?.agent.id === a.id}
            aria-label={a.apiEnabled ? `关闭「${a.name}」的开放 API` : `开放「${a.name}」的 API`}
            onCheckedChange={(on) => (on ? setApi.mutate({ agent: a, enabled: true }) : setPending({ kind: 'close-api', agent: a }))}
          />
        ),
      },
      {
        id: 'actions',
        header: () => <span className='sr-only'>操作</span>,
        cell: ({ row: { original: a } }) => (
          <div className='flex items-center justify-end gap-1'>
            {a.draftVersion && (
              <Button size='sm' variant='outline' onClick={() => askPublish(a)}>
                <Rocket /> 发布 {versionLabel(a.draftVersion.version)}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant='ghost' size='icon' className='size-8 data-[state=open]:bg-muted' aria-label={`「${a.name}」更多操作`}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align='end' className='w-44'>
                {a.apiEnabled ? (
                  <DropdownMenuItem variant='destructive' onClick={() => setPending({ kind: 'close-api', agent: a })}>
                    关闭开放 API
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onClick={() => setApi.mutate({ agent: a, enabled: true })}>开放 API</DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <a href='/#agents'>
                    <ExternalLink /> 在旧版中查看详情
                  </a>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setApi.isPending, setApi.variables]
  )

  const table = useReactTable({
    data: rows,
    columns,
    state: { globalFilter: query },
    onGlobalFilterChange: setQuery,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 20 } },
    autoResetPageIndex: true,
  })

  const visible = table.getRowModel().rows
  const counts = { all: data?.length ?? 0, draft: data?.filter((a) => a.draftVersion).length ?? 0, api: data?.filter((a) => a.apiEnabled).length ?? 0 }

  return (
    <PageShell
      title='Agents'
      description='管理 Agent 的发布版本和开放 API。'
      actions={
        <Button asChild>
          <a href='/#agents'>
            <Plus /> 新建 Agent
          </a>
        </Button>
      }
    >
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList>
            <TabsTrigger value='all'>全部 <Count n={counts.all} /></TabsTrigger>
            <TabsTrigger value='draft'>有待发布草稿 <Count n={counts.draft} /></TabsTrigger>
            <TabsTrigger value='api'>已开放 API <Count n={counts.api} /></TabsTrigger>
          </TabsList>
        </Tabs>
        <div className='relative'>
          <SearchIcon className='pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground' />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder='搜索名称或 Key' aria-label='搜索 Agent' className='h-9 w-64 ps-8' />
        </div>
      </div>

      <div className='overflow-hidden rounded-lg border bg-card'>
        <Table>
          <TableHeader className='bg-muted/40'>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id} className='hover:bg-transparent'>
                {hg.headers.map((h) => (
                  <TableHead key={h.id} className={h.id === 'actions' ? 'w-56' : h.id === 'name' ? 'w-[36%]' : undefined}>
                    {flexRender(h.column.columnDef.header, h.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {error ? (
              <TableMessage cols={5} kind='error' title={error.message} code={(error as ApiError).code} onRetry={() => void refetch()} />
            ) : isPending ? (
              <SkeletonRows cols={5} />
            ) : visible.length === 0 ? (
              data.length ? (
                <TableMessage cols={5} kind='empty' title='没有符合条件的 Agent' hint='换个关键词或筛选条件试试。' />
              ) : (
                <TableMessage
                  cols={5}
                  kind='empty'
                  title='还没有 Agent'
                  hint='新建 Agent 目前仍在旧版控制台操作，默认使用离线 Mock 模型即可运行。'
                  action={<Button variant='outline' size='sm' className='mt-2' asChild><a href='/#agents'>去旧版新建</a></Button>}
                />
              )
            ) : (
              visible.map((row, i) => (
                <MotionRow key={row.id} {...rowMotion(i)} className='h-13'>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                  ))}
                </MotionRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {table.getPageCount() > 1 && <DataTablePagination table={table} />}

      <ConfirmDialog
        open={pending?.kind === 'publish'}
        onOpenChange={(o) => !o && setPending(null)}
        title={pending?.kind === 'publish' ? `发布「${pending.agent.name}」${versionLabel(pending.draft.version)}` : ''}
        desc={
          pending?.kind === 'publish'
            ? `发布后开放 API 和定时任务会立即改用 ${versionLabel(pending.draft.version)}，${pending.agent.publishedVersion ? `当前线上版本是 ${versionLabel(pending.agent.publishedVersion)}` : '这个 Agent 目前还没有线上版本'}。`
            : ''
        }
        confirmText='确认发布'
        isLoading={publish.isPending}
        handleConfirm={() => pending?.kind === 'publish' && publish.mutate(pending)}
      />
      <ConfirmDialog
        open={pending?.kind === 'close-api'}
        onOpenChange={(o) => !o && setPending(null)}
        destructive
        title={pending ? `关闭「${pending.agent.name}」的开放 API` : ''}
        desc='关闭后外部应用无法再发起新调用；已在运行的任务会继续完成，结果仍可查询。之后可以随时重新开放。'
        confirmText='确认关闭'
        isLoading={setApi.isPending}
        handleConfirm={() => pending?.kind === 'close-api' && setApi.mutate({ agent: pending.agent, enabled: false })}
      />
    </PageShell>
  )
}

function Count({ n }: { n: number }) {
  return <span className='ms-1 rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground'>{n}</span>
}
