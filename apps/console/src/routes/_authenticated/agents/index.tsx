import { createFileRoute } from '@tanstack/react-router'
import { Agents } from '@/features/agents'
import { RouteError } from '@/features/errors/route-error'
import { ROUTE_PERMISSIONS } from '@/lib/permissions'
import { guard } from '@/lib/route-guard'

export const Route = createFileRoute('/_authenticated/agents/')({
  beforeLoad: guard(ROUTE_PERMISSIONS['/agents']),
  errorComponent: RouteError,
  component: Agents,
})
