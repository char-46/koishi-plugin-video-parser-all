import { describe, it, expect } from 'vitest'
import { parseApiResponse } from '../src/engine/parser'

describe('parseApiResponse — 统一解析引擎', () => {
  // 与 config.ts 中 globalFieldMapping 默认值一致
  const FM: Record<string, string> = {
    title: 'data.title', desc: 'data.description', author: 'data.author.name', uid: 'data.author.id',
    avatar: 'data.author.avatar', cover: 'data.cover_url', video: 'data.video_url',
    type: 'data.type', like: 'data.statistics.likes', comment: 'data.statistics.comments',
    collect: 'data.statistics.favorites', share: 'data.statistics.shares', play: 'data.statistics.plays',
    duration: 'data.duration', publishTime: 'data.create_time',
    music_title: 'data.music.title', music_author: 'data.music.author',
    music_cover: 'data.music.cover', music_url: 'data.music.url',
  }

  it('解析标准视频响应（fieldMapping 映射 statistics.likes / cover_url 等）', () => {
    const raw = {
      code: 200,
      data: {
        title: '示例视频',
        author: { name: 'UP主', id: 'u1', avatar: 'https://x/a.png' },
        cover_url: 'https://x/cover.jpg',
        url: 'https://x/v.mp4',
        statistics: { likes: 10, comments: 20, favorites: 30, shares: 40, plays: 50 },
        duration: 90,
        create_time: 1700000000,
        music: { title: 'BGM', author: '歌手', url: 'https://x/m.mp3' },
      },
    }
    const r = parseApiResponse(raw, 200, FM)
    expect(r.title).toBe('示例视频')
    expect(r.author).toBe('UP主')
    expect(r.cover).toBe('https://x/cover.jpg')
    expect(r.video).toBe('https://x/v.mp4')
    expect(r.like).toBe(10)
    expect(r.comment).toBe(20)
    expect(r.collect).toBe(30)
    expect(r.share).toBe(40)
    expect(r.play).toBe(50)
    expect(r.duration).toBe(90)
    expect(r.type).toBe('video')
    expect(r.publishTime).toBe(1700000000 * 1000) // 秒级 → 毫秒
    expect(r.music.title).toBe('BGM')
  })

  it('images 非空且无 url → 推断为 image（图集）', () => {
    const r = parseApiResponse({ code: 200, data: { images: ['https://x/1.jpg', 'https://x/2.jpg'] } }, 200)
    expect(r.type).toBe('image')
    expect(r.images).toHaveLength(2)
    expect(r.video).toBe('')
  })

  it('live_photo 非空 → 推断为 live_photo', () => {
    const r = parseApiResponse({
      code: 200,
      data: { live_photo: [{ image: 'https://x/lp.jpg', video: 'https://x/lp.mp4' }] },
    }, 200)
    expect(r.type).toBe('live_photo')
    expect(r.live_photo[0].image).toBe('https://x/lp.jpg')
  })

  it('raw.msg === live → 推断为 live（直播）', () => {
    const r = parseApiResponse({ code: 200, msg: 'live', data: {} }, 200)
    expect(r.type).toBe('live')
  })

  it('中文计数解析：万 / 亿', () => {
    const r = parseApiResponse({ code: 200, data: { statistics: { likes: '1.2万', plays: '3亿' } } }, 200)
    expect(r.like).toBe(12000)
    expect(r.play).toBe(300000000)
  })

  it('自定义 fieldMapping 优先于内置 fallback', () => {
    const raw = { code: 200, data: {}, myTitle: ['自定义标题'] }
    const mapping = { title: 'myTitle.0' }
    const r = parseApiResponse(raw, 200, mapping as any)
    expect(r.title).toBe('自定义标题')
  })

  it('补 https 协议前缀', () => {
    const r = parseApiResponse({ code: 200, data: { cover: '//x/c.jpg', url: '//x/v.mp4' } }, 200)
    expect(r.cover).toBe('https://x/c.jpg')
    expect(r.video).toBe('https://x/v.mp4')
  })

  it('标题与简介相同 → 简介置空', () => {
    const r = parseApiResponse({ code: 200, data: { title: '重复', description: '重复' } }, 200)
    expect(r.title).toBe('重复')
    expect(r.desc).toBe('')
  })

  it('video_backup 多清晰度 → 按码率排序取最高', () => {
    const r = parseApiResponse({
      code: 200,
      data: { video_backup: [
        { quality: '480p', url: 'https://x/480.mp4', bit_rate: 480 },
        { quality: '1080p', url: 'https://x/1080.mp4', bit_rate: 1080 },
      ] },
    }, 200)
    expect(r.videos[0].quality).toBe('1080p')
    expect(r.video).toBe('https://x/1080.mp4')
  })
})
