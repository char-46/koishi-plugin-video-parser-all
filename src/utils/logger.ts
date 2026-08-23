/**
 * 日志分级：
 * - info/warn/error 正常输出（不受 debug 配置影响）
 * - debug/verbose 级日志默认走 koishi debug 级（控制台不显示）；
 *   配置项 debug=true 时提升为 info 输出
 */
import { Logger } from 'koishi'
import { name } from '../config'

export const logger = new Logger(name)

let verbose = false

export function setVerboseLogging(v: boolean): void {
  verbose = v
}

function fmt(args: any[]): string {
  return args.map(a => {
    try {
      return typeof a === 'object' ? JSON.stringify(a) : String(a)
    } catch {
      return '[unserializable]'
    }
  }).join(' ')
}

/** debug/verbose 级日志：debug 配置开启后提升为 info，否则 koishi debug 级 */
export function debugLog(...args: any[]): void {
  const line = fmt(args)
  if (verbose) logger.info(line)
  else logger.debug(line)
}
