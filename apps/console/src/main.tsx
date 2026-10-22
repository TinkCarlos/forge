import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import { MotionConfig } from 'motion/react'
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { toast } from 'sonner'
import { ApiError, setUnauthorizedHandler } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import { DirectionProvider } from './context/direction-provider'
import { FontProvider } from './context/font-provider'
import { ThemeProvider } from './context/theme-provider'
import { routeTree } from './routeTree.gen'
import './styles/index.css'

const queryClient: QueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
      refetchOnWindowFocus: import.meta.env.PROD,
      staleTime: 10 * 1000,
    },
  },
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof ApiError && error.status >= 500) toast.error('服务暂时不可用', { description: error.code })
    },
  }),
})

const router = createRouter({
  routeTree,
  basepath: '/next',
  context: { queryClient },
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
})

setUnauthorizedHandler(() => {
  if (!useAuthStore.getState().session) return
  useAuthStore.getState().reset()
  toast.error('登录已过期，请重新登录')
  void router.navigate({ to: '/sign-in', search: { redirect: router.history.location.href } })
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const rootElement = document.getElementById('root')!
if (!rootElement.innerHTML) {
  ReactDOM.createRoot(rootElement).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <FontProvider>
            <DirectionProvider>
              {/* 系统开启「减少动态效果」时，motion 自动只保留透明度变化 */}
              <MotionConfig reducedMotion='user'>
                <RouterProvider router={router} />
              </MotionConfig>
            </DirectionProvider>
          </FontProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </StrictMode>
  )
}
