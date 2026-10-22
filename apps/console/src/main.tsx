import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import { MotionConfig, MotionGlobalConfig } from 'motion/react'

// 「减少动态效果」：MotionConfig 的 reducedMotion='user' 只去掉位移、仍会淡入，
// 这里让 motion 直接跳到终态（页面切换、列表入场、登录卡片都停），并跟随系统设置实时切换。
const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
MotionGlobalConfig.skipAnimations = reduceQuery.matches
reduceQuery.addEventListener('change', (e) => {
  MotionGlobalConfig.skipAnimations = e.matches
})
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
              {/* 减少动态效果时 motion 跳过动画，见文件顶部 MotionGlobalConfig */}
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
