#!/usr/bin/env node
// 运行时 CSP 检查：在服务端下发的严格 CSP 下打开 /next/ 主要页面，触发 ⌘K、对话框、下拉框、选择框、⋯ 菜单，
// 断言 securitypolicyviolation 为 0 次、没有页面异常、每个交互都真的打开了。任一不满足 → 退出码 1。
//
// 用法：node apps/console/scripts/csp-runtime-check.mjs --origin http://127.0.0.1:<port>
//   账号：CSP_CHECK_EMAIL / CSP_CHECK_PASSWORD（缺省读 FORGE_ADMIN_EMAIL / FORGE_ADMIN_PASSWORD），只在内存里用，不打印。
//   浏览器：CHROME_PATH（缺省 macOS 的 Google Chrome）。不依赖 puppeteer，直接走 Chrome DevTools Protocol。
//   --out <file> 把 JSON 结果另存一份。
//   数据要求：agents 多于 20 条（分页的 Radix Select 才会出现），否则「选择框」这步算失败，不会静默跳过。
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []))
const ORIGIN = (args.origin ?? process.env.CSP_CHECK_ORIGIN ?? '').replace(/\/$/, '')
const EMAIL = process.env.CSP_CHECK_EMAIL ?? process.env.FORGE_ADMIN_EMAIL
const PASSWORD = process.env.CSP_CHECK_PASSWORD ?? process.env.FORGE_ADMIN_PASSWORD
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
if (!ORIGIN || !EMAIL || !PASSWORD) {
  console.error('需要 --origin，以及 CSP_CHECK_EMAIL/CSP_CHECK_PASSWORD（或 FORGE_ADMIN_EMAIL/FORGE_ADMIN_PASSWORD）')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** script-src / style-src 都不能带 unsafe-inline / unsafe-eval，否则这条检查没有意义。 */
export function cspIsStrict(header) {
  if (!header) return false
  const dirs = Object.fromEntries(header.split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([k, ...v]) => [k, v]))
  const check = (name) => {
    const v = dirs[name] ?? dirs['default-src']
    return !!v && !v.some((s) => /^'unsafe-(inline|eval|hashes)'$/.test(s))
  }
  return check('script-src') && check('style-src')
}

async function startChrome() {
  const dir = mkdtempSync(join(tmpdir(), 'csp-check-'))
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  const ws = await new Promise((resolve, reject) => {
    let buf = ''
    const t = setTimeout(() => reject(new Error('Chrome 启动超时')), 20000)
    proc.stderr.on('data', (d) => {
      buf += d
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/)
      if (m) { clearTimeout(t); resolve(m[1]) }
    })
    proc.on('exit', (c) => reject(new Error(`Chrome 退出：${c}`)))
  })
  return { proc, ws, dir }
}

function cdp(url) {
  const sock = new WebSocket(url)
  let seq = 0
  const pending = new Map()
  const listeners = []
  sock.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(`${msg.error.message}`)) : resolve(msg.result)
    } else if (msg.method) listeners.forEach((l) => l(msg))
  })
  const ready = new Promise((r, j) => { sock.addEventListener('open', r); sock.addEventListener('error', j) })
  return {
    ready,
    send: (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); sock.send(JSON.stringify({ id, method, params, sessionId })) }),
    on: (fn) => listeners.push(fn),
    close: () => sock.close(),
  }
}

async function openPage(conn, theme) {
  const { browserContextId } = await conn.send('Target.createBrowserContext')
  const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank', browserContextId })
  const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true })
  const s = (m, p) => conn.send(m, p, sessionId)
  const state = { violations: [], errors: [], loads: 0, csp: null, step: '' }
  conn.on((msg) => {
    if (msg.sessionId !== sessionId) return
    if (msg.method === 'Runtime.bindingCalled' && msg.params.name === '__cspViolation') state.violations.push(`${state.step} | ${msg.params.payload}`)
    if (msg.method === 'Runtime.exceptionThrown') state.errors.push(String(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text).slice(0, 200))
    if (msg.method === 'Page.loadEventFired') state.loads++
    if (msg.method === 'Network.responseReceived' && msg.params.type === 'Document' && new URL(msg.params.response.url).pathname.startsWith('/next')) {
      const h = msg.params.response.headers
      state.csp = h['content-security-policy'] ?? h['Content-Security-Policy'] ?? null
    }
  })
  await s('Page.enable'); await s('Runtime.enable'); await s('Network.enable')
  await s('Runtime.addBinding', { name: '__cspViolation' })
  await s('Page.addScriptToEvaluateOnNewDocument', {
    source: `document.addEventListener('securitypolicyviolation', (e) => __cspViolation([e.effectiveDirective, e.blockedURI || '-', (e.sourceFile || '') + ':' + e.lineNumber, location.pathname].join(' | ')))`,
  })
  await s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: theme }] })
  await s('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await s('Network.setCookie', { name: 'vite-ui-theme', value: theme, url: ORIGIN })

  const evaluate = async (expression) => {
    const r = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(`evaluate 失败：${r.exceptionDetails.text}`)
    return r.result.value
  }
  const waitFor = async (expression, timeout = 8000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) { if (await evaluate(`!!(${expression})`)) return true; await sleep(100) }
    return false
  }
  const goto = async (path) => {
    const before = state.loads
    await s('Page.navigate', { url: ORIGIN + path })
    const end = Date.now() + 15000
    while (state.loads === before && Date.now() < end) await sleep(50)
    await sleep(800)
  }
  /** 用真实鼠标事件点元素中心（Radix 的触发器认 pointerdown，el.click() 不够）。 */
  const click = async (selectorExpr) => {
    const box = await evaluate(`(() => { const el = ${selectorExpr}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    if (!box) return false
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await s('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1, pointerType: 'mouse' })
    return true
  }
  const key = async (k, code, vk, modifiers = 0) => {
    await s('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers })
    await s('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers })
  }
  const type = async (selector, text) => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`); await s('Input.insertText', { text }) }
  return { state, evaluate, waitFor, goto, click, key, type, close: () => conn.send('Target.disposeBrowserContext', { browserContextId }) }
}

const byText = (sel, text) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((el) => el.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(text)}))`
const OVERLAY = `document.querySelector('[role=menu],[role=dialog],[role=alertdialog],[role=listbox]')`

async function run(conn, theme) {
  const p = await openPage(conn, theme)
  const steps = {}
  const step = async (name, fn) => {
    p.state.step = name
    try { steps[name] = !!(await fn()) } catch (e) { steps[name] = false; p.state.errors.push(`${name}: ${e.message}`) }
  }
  const openAndClose = async (trigger, expect = OVERLAY) => {
    if (!(await p.click(trigger))) return false
    const opened = await p.waitFor(expect, 4000)
    await sleep(400)
    await p.key('Escape', 'Escape', 27)
    const closed = await p.waitFor(`!${OVERLAY}`, 4000)
    await sleep(200)
    return opened && closed
  }
  try {
    await step('sign-in 页', async () => { await p.goto('/next/sign-in'); return p.waitFor(`document.querySelector('#email')`) })
    await step('登录进 /next/agents', async () => {
      await p.type('#email', EMAIL); await p.type('#password', PASSWORD)
      await p.click(`document.querySelector('button[type=submit]')`)
      return p.waitFor(`location.pathname.startsWith('/next/agents')`, 15000)
    })
    await step('agents 列表', () => p.waitFor(`document.querySelector('main table, main [role=table], main')`))
    await step('⋯ 菜单', () => openAndClose(`document.querySelector('button[aria-label*="更多操作"]')`, `document.querySelector('[role=menu]')`))
    await step('下拉框（主题切换）', () => openAndClose(byText('button', '切换主题'), `document.querySelector('[role=menu]')`))
    // 分页的每页条数是 Radix Select；agents 需要多于 1 页（> 20 条）才会出现
    await step('选择框（分页每页条数，Radix Select）', () => openAndClose(`document.querySelector('main button[role=combobox]')`, `document.querySelector('[role=listbox]')`))
    await step('对话框（退出登录确认，只按 Esc 取消）', async () => {
      const trigger = `document.querySelector('[data-sidebar=footer] button, [data-slot=sidebar-footer] button')`
      if (!(await p.click(trigger))) throw new Error('找不到用户菜单触发器')
      if (!(await p.waitFor(`document.querySelector('[role=menu]')`, 4000))) throw new Error('用户菜单没打开')
      await sleep(400) // 等 Popper 定位完，否则点到的是定位前的坐标
      if (!(await p.click(byText('[role=menuitem]', '退出登录')))) throw new Error('找不到「退出登录」菜单项')
      const opened = await p.waitFor(`document.querySelector('[role=alertdialog]')`, 4000)
      if (!opened) throw new Error('退出确认框没打开')
      await sleep(300)
      await p.key('Escape', 'Escape', 27)
      const closed = await p.waitFor(`!${OVERLAY}`, 4000)
      return opened && closed && (await p.evaluate(`location.pathname.startsWith('/next/agents')`))
    })
    await step('⌘K 命令面板', async () => {
      await p.key('k', 'KeyK', 75, 4)
      let opened = await p.waitFor(`document.querySelector('[cmdk-root]')`, 3000)
      if (!opened) { await p.key('k', 'KeyK', 75, 2); opened = await p.waitFor(`document.querySelector('[cmdk-root]')`, 3000) }
      await sleep(500)
      await p.key('Escape', 'Escape', 27)
      return opened && (await p.waitFor(`!document.querySelector('[cmdk-root]')`, 4000))
    })
    await step('approvals 页', async () => { await p.goto('/next/approvals'); return p.waitFor(`document.body.innerText.includes('审批')`) })
    await step('404 页', async () => { await p.goto('/next/does-not-exist'); return p.waitFor(`document.body.innerText.trim().length > 0`) })
  } finally {
    await p.close().catch(() => {})
  }
  return { steps, violations: p.state.violations, pageErrors: p.state.errors, csp: p.state.csp }
}

const chrome = await startChrome()
let result
try {
  const conn = cdp(chrome.ws)
  await conn.ready
  const runs = {}
  for (const theme of ['light', 'dark']) runs[theme] = await run(conn, theme)
  conn.close()
  const csp = runs.light.csp
  const violations = Object.values(runs).flatMap((r) => r.violations)
  const pageErrors = Object.values(runs).flatMap((r) => r.pageErrors)
  const failedSteps = Object.entries(runs).flatMap(([t, r]) => Object.entries(r.steps).filter(([, ok]) => !ok).map(([n]) => `${t}: ${n}`))
  result = { origin: ORIGIN, csp, cspStrict: cspIsStrict(csp), runs, totalViolations: violations.length, pageErrors: pageErrors.length, failedSteps }
  result.ok = result.cspStrict && result.totalViolations === 0 && result.pageErrors === 0 && failedSteps.length === 0
} finally {
  chrome.proc.kill('SIGTERM')
  await sleep(300)
  rmSync(chrome.dir, { recursive: true, force: true })
}
const json = JSON.stringify(result, null, 1)
if (args.out) writeFileSync(args.out, json + '\n')
console.log(json)
console.log(result.ok ? 'CSP 运行时检查：通过（0 违规）' : `CSP 运行时检查：失败（违规 ${result.totalViolations}，页面异常 ${result.pageErrors}，未完成步骤 ${result.failedSteps.length}，CSP 严格 ${result.cspStrict}）`)
process.exit(result.ok ? 0 : 1)
