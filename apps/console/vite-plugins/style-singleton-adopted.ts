import type { Plugin } from 'vite'

/**
 * FE-CSP-03：Radix 的弹层（Dialog、AlertDialog、DropdownMenu、Sheet…）经 react-remove-scroll
 * → react-style-singleton 在打开时往 <head> 插 <style> 锁住 body 滚动。/next/ 的 style-src 'self'
 * 会拦掉它（每次打开 2 条 style-src-elem 违规），滚动锁也随之失效。
 * 这里把 react-style-singleton 的 singleton 模块换成 constructable stylesheet 版本：
 * CSSOM（CSSStyleSheet.replaceSync + document.adoptedStyleSheets）不受 style-src 限制，
 * 导出名、引用计数语义和原模块一致。
 */
export const ADOPTED_SINGLETON = `export var stylesheetSingleton = function () {
  var counter = 0;
  var sheet = null;
  return {
    add: function (style) {
      if (counter == 0 && typeof document !== 'undefined') {
        sheet = new CSSStyleSheet();
        sheet.replaceSync(style);
        document.adoptedStyleSheets = document.adoptedStyleSheets.concat([sheet]);
      }
      counter++;
    },
    remove: function () {
      counter--;
      if (!counter && sheet) {
        var current = sheet;
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter(function (s) { return s !== current; });
        sheet = null;
      }
    },
  };
};
`

export function isStyleSingletonModule(id: string): boolean {
  return /[\\/]node_modules[\\/]react-style-singleton[\\/]dist[\\/][^\\/]+[\\/]singleton\.js$/.test(id.split('?')[0])
}

export function styleSingletonAdopted(): Plugin {
  return {
    name: 'forge:style-singleton-adopted',
    enforce: 'pre',
    load(id) {
      return isStyleSingletonModule(id) ? ADOPTED_SINGLETON : null
    },
  }
}
