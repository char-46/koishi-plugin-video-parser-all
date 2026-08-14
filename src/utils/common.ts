import type { VideoQuality, ParsedData } from '../types'

export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) return String((error as Record<string, unknown>).message)
  return String(error)
}

export function parseCount(val: any): number {
  if (val === undefined || val === null) return 0
  if (typeof val === 'number') return val
  const str = String(val).trim()
  if (str.includes('万')) {
    const num = parseFloat(str)
    return isNaN(num) ? 0 : Math.round(num * 10000)
  }
  if (str.includes('亿')) {
    const num = parseFloat(str)
    return isNaN(num) ? 0 : Math.round(num * 100000000)
  }
  const num = parseInt(str, 10)
  return isNaN(num) ? 0 : num
}

export function pickBestQuality(videoBackup: any[]): VideoQuality[] {
  if (!Array.isArray(videoBackup)) return []
  return videoBackup.filter(v => v && v.url).map(v => ({
    quality: v.quality || v.label || 'unknown',
    url: v.url,
    bit_rate: Number(v.bit_rate || 0)
  })).sort((a, b) => b.bit_rate - a.bit_rate)
}

export function contentFingerprint(p: ParsedData): string {
  const imgSig = p.images?.length ? p.images.slice(0, 3).join('|') : (p.live_photo?.slice(0, 3).map(lp => lp.image).join('|') || '')
  return [p.type, p.title, p.author, p.uid, p.video, imgSig].map(v => String(v ?? '')).join('::')
}

export function getText(config: any, key: string): string {
  const defaults: Record<string, string> = {
    waitingTipText: '正在解析视频，请稍候...',
    unsupportedPlatformText: '不支持该平台链接',
    invalidLinkText: '无效的视频链接',
    parseErrorPrefix: '❌ 解析失败：',
    parseErrorItemFormat: '【${url}】: ${msg}',
    deduplicationTipText: '链接 ${url} 在最近 ${interval} 秒内已解析过，已跳过。',
  }
  return config[key] || defaults[key] || ''
}
