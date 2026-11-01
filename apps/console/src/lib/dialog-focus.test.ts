import { afterEach, describe, expect, it, vi } from 'vitest'
import { restoreDialogFocus } from './dialog-focus'

afterEach(() => vi.unstubAllGlobals())

function element(connected = true, insideDialog = false) {
  return { isConnected: connected, focus: vi.fn(), closest: vi.fn(() => insideDialog ? {} : null) }
}

function page(active: ReturnType<typeof element> | null = null) {
  const body = element()
  const heading = element()
  vi.stubGlobal('document', { body, activeElement: active ?? body, querySelector: () => heading })
  return { heading }
}

describe('controlled dialog close focus', () => {
  it('returns focus to the opener after the closing dialog releases it to body', () => {
    const { heading } = page()
    const opener = element()
    const event = new Event('closeAutoFocus', { cancelable: true })
    restoreDialogFocus(event, opener as unknown as HTMLElement)
    expect(event.defaultPrevented).toBe(true)
    expect(opener.focus).toHaveBeenCalledOnce()
    expect(heading.focus).not.toHaveBeenCalled()
  })

  it('returns focus when the closing dialog still owns it', () => {
    page(element(true, true))
    const opener = element()
    restoreDialogFocus(new Event('closeAutoFocus'), opener as unknown as HTMLElement)
    expect(opener.focus).toHaveBeenCalledOnce()
  })

  it('uses the page heading when the original row was removed', () => {
    const { heading } = page()
    const opener = element(false)
    restoreDialogFocus(new Event('closeAutoFocus'), opener as unknown as HTMLElement)
    expect(opener.focus).not.toHaveBeenCalled()
    expect(heading.focus).toHaveBeenCalledOnce()
  })

  it('does not steal focus already moved by navigation or the user', () => {
    const { heading } = page(element())
    const opener = element()
    const event = new Event('closeAutoFocus', { cancelable: true })
    restoreDialogFocus(event, opener as unknown as HTMLElement)
    expect(event.defaultPrevented).toBe(true)
    expect(opener.focus).not.toHaveBeenCalled()
    expect(heading.focus).not.toHaveBeenCalled()
  })

  it('falls back to the page heading when opened without a focused element', () => {
    const { heading } = page()
    restoreDialogFocus(new Event('closeAutoFocus'), null)
    expect(heading.focus).toHaveBeenCalledOnce()
  })
})
