/**
 * koishi 测试桩：让测试无需加载真实 koishi（真实 koishi 依赖 @koishijs/loader，
 * 在 vitest 环境下因模块初始化顺序会抛 "Class extends value is not a constructor"）。
 * 通过 vitest.config.ts 的 alias 将 'koishi' 指向本文件。
 */

export class Logger {
  constructor(public name?: string) {}
  info(..._args: any[]) {}
  warn(..._args: any[]) {}
  error(..._args: any[]) {}
  debug(..._args: any[]) {}
  success(..._args: any[]) {}
}

/** 可链式调用的 Schema 构造桩：default/description/required/role/hidden/min/step 等均返回自身 */
function chainable(): any {
  const obj: any = {}
  for (const m of ['default', 'description', 'required', 'role', 'hidden', 'min', 'max', 'step', 'sibling', 'show', 'allow', 'forbid', 'deprecated', 'experimental']) {
    obj[m] = (..._args: any[]) => obj
  }
  return obj
}

const Schema: any = (..._args: any[]) => chainable()
Schema.object = (..._args: any[]) => chainable()
Schema.array = (..._args: any[]) => chainable()
Schema.intersect = (..._args: any[]) => chainable()
Schema.union = (..._args: any[]) => chainable()
Schema.const = (..._args: any[]) => chainable()
Schema.boolean = (..._args: any[]) => chainable()
Schema.string = (..._args: any[]) => chainable()
Schema.number = (..._args: any[]) => chainable()
Schema.any = (..._args: any[]) => chainable()
export { Schema }

export type Context = any

/** 虚拟元素构造：与 koishi 的 h 结构一致（{ type, attrs, children }），供断言用 */
const h: any = (type: string, attrs?: any, children?: any) => ({ type, attrs: attrs || {}, children: children || [] })
h.image = (url: string) => ({ type: 'img', attrs: { src: url } })
h.video = (url: string) => ({ type: 'video', attrs: { src: url } })
h.audio = (url: string) => ({ type: 'audio', attrs: { src: url } })
h.text = (s: string) => ({ type: 'text', attrs: { content: s } })
h.quote = (id: any) => ({ type: 'quote', attrs: { id } })
h.element = (type: string, attrs?: any, children?: any) => ({ type, attrs: attrs || {}, children: children || [] })
export { h }
