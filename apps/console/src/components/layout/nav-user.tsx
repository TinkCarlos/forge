import { ChevronsUpDown, ExternalLink, LogOut } from 'lucide-react'
import useDialogState from '@/hooks/use-dialog-state'
import { useAuthStore } from '@/stores/auth-store'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { SignOutDialog } from '@/components/sign-out-dialog'

export function NavUser() {
  const { isMobile } = useSidebar()
  const user = useAuthStore((s) => s.user)
  const [open, setOpen] = useDialogState()
  const name = user?.name || user?.email || '管理员'
  const initial = name.slice(0, 1).toUpperCase()

  const identity = (
    <>
      <Avatar className='h-8 w-8 rounded-lg'>
        <AvatarFallback className='rounded-lg bg-primary/10 text-primary'>{initial}</AvatarFallback>
      </Avatar>
      <div className='grid flex-1 text-start text-sm leading-tight'>
        <span className='truncate font-semibold'>{name}</span>
        <span className='truncate text-xs text-muted-foreground'>{user?.email ?? user?.role}</span>
      </div>
    </>
  )

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton size='lg' className='data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground'>
                {identity}
                <ChevronsUpDown className='ms-auto size-4' />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className='w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg'
              side={isMobile ? 'bottom' : 'right'}
              align='end'
              sideOffset={4}
            >
              <DropdownMenuLabel className='p-0 font-normal'>
                <div className='flex items-center gap-2 px-1 py-1.5 text-start text-sm'>{identity}</div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem asChild>
                  <a href='/'>
                    <ExternalLink />
                    回到旧版控制台
                  </a>
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant='destructive' onClick={() => setOpen(true)}>
                <LogOut />
                退出登录
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      <SignOutDialog open={!!open} onOpenChange={setOpen} />
    </>
  )
}
