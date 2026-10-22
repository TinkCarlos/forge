import { createFileRoute, redirect } from '@tanstack/react-router'
import { api, type Session } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import { AuthenticatedLayout } from '@/components/layout/authenticated-layout'

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: async ({ location }) => {
    if (useAuthStore.getState().session) return
    const session = await api<Session>('/auth/session').catch(() => null)
    if (!session) throw redirect({ to: '/sign-in', search: { redirect: location.href } })
    useAuthStore.getState().setSession(session)
  },
  component: AuthenticatedLayout,
})
