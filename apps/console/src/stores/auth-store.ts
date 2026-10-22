import { create } from 'zustand'
import { type Session, setSession } from '@/lib/api'

type User = { name?: string; email?: string; role?: string }

type AuthState = {
  session: Session | null
  user: User | null
  setSession: (session: Session | null) => void
  reset: () => void
}

/** 会话由服务端 cookie 维持，这里只缓存 /auth/session 的结果和 CSRF token。 */
export const useAuthStore = create<AuthState>()((set) => ({
  session: null,
  user: null,
  setSession: (session) => {
    setSession(session)
    set({ session, user: session ? ((session.user ?? session) as User) : null })
  },
  reset: () => {
    setSession(null)
    set({ session: null, user: null })
  },
}))
