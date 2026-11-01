import { createFileRoute, redirect } from '@tanstack/react-router'
import { defaultLanding, permissionsOf } from '@/lib/permissions'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/')({
  beforeLoad: () => {
    const target = defaultLanding(permissionsOf(useAuthStore.getState().session))
    if (target.startsWith('/#')) throw redirect({ href: target, reloadDocument: true })
    throw redirect({ to: target === '/messages' ? '/messages' : target === '/jobs' ? '/jobs' : target === '/approvals' ? '/approvals' : '/agents' })
  },
})
