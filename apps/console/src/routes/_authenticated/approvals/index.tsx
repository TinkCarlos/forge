import { createFileRoute } from '@tanstack/react-router'
import { Approvals } from '@/features/approvals'
import { RouteError } from '@/features/errors/route-error'
import { ROUTE_PERMISSIONS } from '@/lib/permissions'
import { guard } from '@/lib/route-guard'

export const Route = createFileRoute('/_authenticated/approvals/')({
  beforeLoad: guard(ROUTE_PERMISSIONS['/approvals']),
  errorComponent: RouteError,
  component: Approvals,
})
