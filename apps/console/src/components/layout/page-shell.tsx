import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'
import { PageTransition } from '@/components/motion/page'
import { Header } from './header'
import { Main } from './main'

type PageShellProps = {
  title: string
  description?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
}

export function PageShell({ title, description, actions, children }: PageShellProps) {
  return (
    <>
      <Header fixed>
        <Search placeholder='搜索页面…' />
        <div className='ms-auto flex items-center gap-2'>
          <ThemeSwitch />
        </div>
      </Header>
      <Main>
        <PageTransition className='flex flex-col gap-6'>
          <div className='flex flex-wrap items-end justify-between gap-4'>
            <div>
              <h1 className='text-2xl font-semibold tracking-tight'>{title}</h1>
              {description && <p className='mt-1 text-sm text-muted-foreground'>{description}</p>}
            </div>
            {actions}
          </div>
          {children}
        </PageTransition>
      </Main>
    </>
  )
}
