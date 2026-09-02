import { describe, it, expect } from 'vitest'
import { gifFilter, gifDuration, mp4ToGif, resolveFfmpeg } from '../src/utils/gif'
import { makeRuntime } from './helpers'

describe('gif 工具（推文动图转 GIF）', () => {
  it('resolveFfmpeg：优先内置静态二进制，回退系统 PATH（结果记忆化）', () => {
    const p = resolveFfmpeg()
    expect(typeof p).toBe('string')
    expect(p.length).toBeGreaterThan(0)
    expect(resolveFfmpeg()).toBe(p) // 记忆化：两次一致
  })

  it('gifFilter：宽度/帧率边界收敛', () => {
    expect(gifFilter(480, 15)).toContain('fps=15')
    expect(gifFilter(480, 15)).toContain('scale=480:-2')
    expect(gifFilter(100000, 1000)).toContain('scale=1080:-2') // 上限收敛
    expect(gifFilter(100000, 1000)).toContain('fps=30')
    expect(gifFilter(1, 1)).toContain('scale=120:-2')          // 下限收敛
    expect(gifFilter(1, 1)).toContain('fps=5')
  })

  it('gifDuration：动图时长与上限取小', () => {
    expect(gifDuration(4, 15)).toBe(4)      // 短动图取实际时长
    expect(gifDuration(60, 15)).toBe(15)    // 长动图截断到上限
    expect(gifDuration(0, 15)).toBe(15)     // 未知时长用上限
    expect(gifDuration(-1, 15)).toBe(15)
    expect(gifDuration(100, 61)).toBe(60)   // 上限本身也收敛到 60
  })

  it('mp4ToGif：下载失败返回 null（回退原视频）', async () => {
    const rt: any = makeRuntime()
    rt.http = { get: async () => { throw new Error('net error') } }
    const out = await mp4ToGif(rt, 'https://x/v.mp4', 5, { maxWidth: 480, fps: 15, maxDurationSec: 15 })
    expect(out).toBeNull()
  })

  it('mp4ToGif：下载请求带浏览器 UA + Referer（防 video.twimg.com 403 回归）', async () => {
    const rt: any = makeRuntime()
    let captured: any = null
    rt.http = { get: async (_url: string, cfg: any) => { captured = cfg; throw new Error('stop') } }
    await mp4ToGif(rt, 'https://video.twimg.com/g.mp4', 5, { maxWidth: 480, fps: 15, maxDurationSec: 15 })
    expect(captured.headers['Referer']).toBe('https://twitter.com/')
    expect(captured.headers['User-Agent']).toContain('Mozilla/5.0')
    expect(captured.responseType).toBe('arraybuffer')
  })
})
