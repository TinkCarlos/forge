import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { CommandMenu } from '@/components/command-menu'
import { restoreDialogFocus } from '@/lib/dialog-focus'

type SearchContextType = {
  open: boolean
  setOpen: (open: boolean) => void
  restoreFocus: (event: Event) => void
}

const SearchContext = createContext<SearchContextType | null>(null)

type SearchProviderProps = {
  children: React.ReactNode
}

export function SearchProvider({ children }: SearchProviderProps) {
  const [open, updateOpen] = useState(false)
  const returnTo = useRef<HTMLElement | null>(null)
  const setOpen = useCallback((next: boolean) => {
    if (next && !open) {
      const active = document.activeElement
      returnTo.current = active instanceof HTMLElement && active !== document.body ? active : null
    }
    updateOpen(next)
  }, [open])
  const restoreFocus = useCallback((event: Event) => {
    restoreDialogFocus(event, returnTo.current)
    returnTo.current = null
  }, [])

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen(!open)
      }
    }
    document.addEventListener('keydown', down)
    return () => document.removeEventListener('keydown', down)
  }, [open, setOpen])

  return (
    <SearchContext value={{ open, setOpen, restoreFocus }}>
      {children}
      <CommandMenu />
    </SearchContext>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export const useSearch = () => {
  const searchContext = useContext(SearchContext)

  if (!searchContext) {
    throw new Error('useSearch has to be used within SearchProvider')
  }

  return searchContext
}
