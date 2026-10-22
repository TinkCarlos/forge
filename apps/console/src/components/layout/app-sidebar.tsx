import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Hammer } from 'lucide-react'
import { useLayout } from '@/context/layout-provider'
import { approvalsCountQuery } from '@/features/approvals/api'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar'
import { sidebarData } from './data/sidebar-data'
import { NavGroup } from './nav-group'
import { NavUser } from './nav-user'

export function AppSidebar() {
  const { collapsible, variant } = useLayout()
  const { data: pending } = useQuery(approvalsCountQuery)

  // 待审批数量挂在「审批中心」上
  const groups = useMemo(
    () =>
      sidebarData.navGroups.map((group) => ({
        ...group,
        items: group.items.map((item) =>
          item.url === '/approvals' && pending ? { ...item, badge: pending > 99 ? '99+' : String(pending) } : item
        ),
      })),
    [pending]
  )

  return (
    <Sidebar collapsible={collapsible} variant={variant}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size='lg' asChild>
              <Link to='/agents'>
                <div className='flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground'>
                  <Hammer className='size-4' />
                </div>
                <div className='grid flex-1 text-start text-sm leading-tight'>
                  <span className='truncate font-semibold'>Forge</span>
                  <span className='truncate text-xs text-muted-foreground'>Agent 控制台</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {groups.map((props) => (
          <NavGroup key={props.title} {...props} />
        ))}
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
