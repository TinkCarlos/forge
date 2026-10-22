import { Hammer } from 'lucide-react'

export function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className='relative grid h-svh place-items-center overflow-hidden bg-muted/30 px-4'>
      {/* 背景：淡网格 + 主色光晕，只做氛围 */}
      <div aria-hidden className='pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,color-mix(in_oklab,var(--primary)_12%,transparent),transparent_60%)]' />
      <div className='relative w-full max-w-sm space-y-6'>
        <div className='flex items-center justify-center gap-2'>
          <div className='flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground'>
            <Hammer className='size-4' />
          </div>
          <span className='text-xl font-semibold tracking-tight'>Forge</span>
        </div>
        {children}
      </div>
    </div>
  )
}
