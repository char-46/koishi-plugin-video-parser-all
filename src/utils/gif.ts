/**
 * 视频转 GIF（推文动图用）。
 *
 * ffmpeg 管道两遍法（palettegen + paletteuse），不落盘。
 * ffmpeg 不可用 / 转换失败 / 下载失败 → 返回 null，调用方回退发送原视频。
 */
import { spawn } from 'child_process'
import type { ParserRuntime } from '../runtime'
import { debugLog, logger } from './logger'

export interface GifOptions {
  maxWidth: number
  fps: number
  maxDurationSec: number
}

let ffmpegMissingWarned = false

/** 生成 ffmpeg 滤镜串（导出供测试） */
export function gifFilter(width: number, fps: number): string {
  const w = Math.max(120, Math.min(1080, Math.round(width)))
  const f = Math.max(5, Math.min(30, Math.round(fps)))
  return `fps=${f},scale=${w}:-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer`
}

/** 裁剪实际转换时长：动图时长与上限取小；未知时长用上限 */
export function gifDuration(durationSec: number, maxDurationSec: number): number {
  const max = Math.max(1, Math.min(60, maxDurationSec))
  if (!durationSec || durationSec <= 0) return max
  return Math.max(1, Math.min(max, Math.round(durationSec)))
}

function runFfmpeg(input: Buffer, vf: string, durationSec: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-t', String(durationSec),
      '-vf', vf,
      '-f', 'gif', 'pipe:1',
    ])
    const out: Buffer[] = []
    let err = ''
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => { err += d.toString() })
    child.on('error', (e) => {
      if (!ffmpegMissingWarned) {
        ffmpegMissingWarned = true
        logger.warn(`GIF 转换需要 ffmpeg（当前环境 PATH 中不可用，动图将回退为视频发送）：${e.message}`)
      }
      resolve(null)
    })
    child.on('close', (code) => {
      if (code === 0 && out.length) resolve(Buffer.concat(out))
      else {
        debugLog('ffmpeg 转换 GIF 失败:', `code=${code}`, err.slice(0, 200))
        resolve(null)
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

/** 下载视频并转 GIF；任何失败返回 null */
export async function mp4ToGif(rt: ParserRuntime, url: string, durationSec: number, opts: GifOptions): Promise<Buffer | null> {
  try {
    const res = await rt.http.get(url, {
      responseType: 'arraybuffer',
      timeout: Math.min(rt.config.timeout || 60000, 120000),
      headers: { 'User-Agent': rt.config.userAgent },
    })
    const input = Buffer.from(res.data)
    if (!input.length) return null
    return await runFfmpeg(input, gifFilter(opts.maxWidth, opts.fps), gifDuration(durationSec, opts.maxDurationSec))
  } catch (e: any) {
    debugLog('GIF 源视频下载失败:', e?.message || e)
    return null
  }
}
