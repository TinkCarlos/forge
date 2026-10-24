/** K-32：跳旧版控制台的入口一律在新标签页打开，当前的新控制台不被替换。 */
export const LEGACY_LINK_ATTRS = { target: '_blank', rel: 'noopener noreferrer' } as const

/** 给读屏和悬停提示用的说明。 */
export const LEGACY_LINK_HINT = '在新标签页打开旧版控制台'

/** ⌘K 等用代码跳转的地方用这个，和链接行为一致。 */
export function openLegacy(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer')
}
