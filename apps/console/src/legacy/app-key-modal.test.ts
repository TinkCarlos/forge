import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const source = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')
function fn(name: string) {
  const match = source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^\\}`, 'm'))
  if (!match) throw new Error(`missing ${name}`)
  return match[0]
}

type Event = { preventDefault(): void }
function harness() {
  const events: Record<string, (() => void)[]> = {}
  const trigger = { isConnected: true }
  let focused = 0
  const dialog = {
    ownerDocument: { activeElement: trigger },
    open: false,
    oncancel: (event: Event) => { event.preventDefault() },
    close() { this.open = false; for (const cb of events.close ?? []) cb() },
    showModal() { this.open = true },
    addEventListener(name: string, cb: () => void) { (events[name] ??= []).push(cb) },
  }
  const cancel = { type: '', disabled: false, onclick: () => {} }
  const submit = { disabled: false }
  const body = { innerHTML: '' }
  const secret = { textContent: 'test-secret' }
  const credential = { value: 'synthetic-input-value' }
  const field = { value: 'Initial', checked: false }
  const discard = { allow: false, calls: 0 }
  const form = { querySelectorAll: (selector: string) => selector === '[data-credential-input]' ? [credential] : selector === 'input, textarea, select' ? [field, credential] : [cancel], onsubmit: async (event: Event) => { event.preventDefault() } }
  const elements: Record<string, unknown> = { '#modal': dialog, '#modal-form': form, '#modal-submit': submit, '#modal-title': {}, '#modal-body': body, '.api-key-secret': secret, '#content .card-head button': { focus: () => { focused++ } } }
  const toasts: string[] = []
  const deps = { bindConfigurationFields: () => {}, $: (id: string) => elements[id], FormData: class {}, confirm: () => { discard.calls++; return discard.allow }, toast: (m: string) => toasts.push(m), errorText: (e: Error) => e.message }
  const names = Object.keys(deps)
  const app = new Function(...names, `${fn('esc')}\n${fn('openModal')}\n${fn('showAppKey')}\nreturn {openModal,showAppKey}`)(...Object.values(deps)) as {
    openModal(title: string, body: string, submit: () => Promise<unknown>): void
    showAppKey(result: unknown): void
  }
  return { app, dialog, cancel, submit, form, body, secret, credential, field, discard, toasts, trigger, focused: () => focused }
}

it('keeps edited fields when Escape or cancel is declined, then closes only after discard is confirmed', () => {
  const h = harness()
  h.app.openModal('edit', '', async () => {})
  h.field.value = 'Unsaved draft'
  let prevented = false
  h.dialog.oncancel({ preventDefault() { prevented = true } })
  expect(prevented).toBe(true)
  expect(h.dialog.open).toBe(true)
  expect(h.field.value).toBe('Unsaved draft')
  h.cancel.onclick()
  expect(h.dialog.open).toBe(true)
  expect(h.discard.calls).toBe(2)
  h.discard.allow = true
  h.cancel.onclick()
  expect(h.dialog.open).toBe(false)
  expect(h.credential.value).toBe('')
})

it('does not prompt for unchanged fields or edits reverted to their original values', () => {
  const h = harness()
  h.app.openModal('edit', '', async () => {})
  h.field.value = 'Changed'
  h.field.value = 'Initial'
  h.field.checked = true
  h.field.checked = false
  h.cancel.onclick()
  expect(h.dialog.open).toBe(false)
  expect(h.discard.calls).toBe(0)
})

it('protects checkbox changes and preserves the draft after submission failure', async () => {
  const h = harness()
  h.app.openModal('permissions', '', async () => { throw new Error('conflict') })
  h.field.checked = true
  await h.form.onsubmit({ preventDefault() {} })
  h.cancel.onclick()
  expect(h.dialog.open).toBe(true)
  expect(h.field.checked).toBe(true)
  expect(h.discard.calls).toBe(1)
})

it('successful submit closes an edited form without a discard prompt', async () => {
  const h = harness()
  h.app.openModal('edit', '', async () => {})
  h.field.value = 'Saved'
  await h.form.onsubmit({ preventDefault() {} })
  expect(h.dialog.open).toBe(false)
  expect(h.discard.calls).toBe(0)
})

it('blocks close, Escape and duplicate submit while pending, then preserves the secret result modal', async () => {
  const h = harness()
  let resolve!: () => void
  const pending = new Promise<void>(r => { resolve = r })
  let calls = 0
  h.app.openModal('rotate', '', async () => {
    calls++
    await pending
    h.app.showAppKey({ key: 'test-secret', prefix: 'fsk_prefix', secretAvailable: true })
    return false
  })
  const event = { preventDefault() {} }
  const request = h.form.onsubmit(event)
  expect(h.submit.disabled).toBe(true)
  expect(h.cancel.disabled).toBe(true)
  h.cancel.onclick()
  expect(h.dialog.open).toBe(true)
  let prevented = false
  h.dialog.oncancel({ preventDefault() { prevented = true } })
  expect(prevented).toBe(true)
  await h.form.onsubmit(event)
  expect(calls).toBe(1)
  resolve()
  await request
  expect(h.dialog.open).toBe(true)
  expect(h.submit.disabled).toBe(false)
  h.cancel.onclick()
  expect(h.secret.textContent).toBe('')
})

it('shows the new prefix after a metadata-only replay and restores close after failure', async () => {
  const h = harness()
  h.app.showAppKey({ prefix: 'fsk_<new>', secretAvailable: false })
  expect(h.body.innerHTML).toContain('fsk_&lt;new&gt;')
  expect(h.body.innerHTML).not.toContain('api-key-secret')
  h.app.openModal('rotate', '', async () => { throw new Error('offline') })
  await h.form.onsubmit({ preventDefault() {} })
  expect(h.toasts).toEqual(['offline'])
  expect(h.cancel.disabled).toBe(false)
  h.cancel.onclick()
  expect(h.dialog.open).toBe(false)
})

it('retains write-only values on a conflict and clears them when the user closes the form', async () => {
  const h = harness()
  h.app.openModal('credential', '', async () => { throw new Error('conflict') })
  await h.form.onsubmit({ preventDefault() {} })
  expect(h.credential.value).toBe('synthetic-input-value')
  expect(h.dialog.open).toBe(true)
  h.cancel.onclick()
  expect(h.credential.value).toBe('')
})

it('returns focus to the page action when a successful save replaces the original trigger', async () => {
  const h = harness()
  h.app.openModal('credential', '', async () => { h.trigger.isConnected = false })
  await h.form.onsubmit({ preventDefault() {} })
  expect(h.focused()).toBe(1)
})
