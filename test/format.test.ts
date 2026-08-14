import { describe, it, expect } from 'vitest'
import { generateFormattedText, formatDuration, formatPublishTime } from '../src/utils/format'
import type { ParsedData } from '../src/types'

function base(over: Partial<ParsedData> = {}): ParsedData {
  return {
    type: 'video', title: '', desc: '', author: '', uid: '', avatar: '', cover: '',
    video: '', videos: [], images: [], live_photo: [], music: {},
    like: 0, comment: 0, collect: 0, share: 0, play: 0, duration: 0, publishTime: 0,
    author_followers: 0, author_signature: '', admire: 0, ...over,
  }
}

describe('formatDuration', () => {
  it('秒 → mm:ss', () => expect(formatDuration(75)).toBe('01:15'))
  it('小时 → h:mm:ss', () => expect(formatDuration(3661)).toBe('1:01:01'))
  it('0 / 负数 → 空', () => expect(formatDuration(0)).toBe(''))
})

describe('formatPublishTime', () => {
  it('格式化为 YYYY年MM月DD日 HH:mm', () => {
    const s = formatPublishTime(new Date('2024-03-05T08:30:00Z').getTime())
    expect(s).toMatch(/2024年\d{2}月\d{2}日 \d{2}:\d{2}/)
  })
  it('0 → 空', () => expect(formatPublishTime(0)).toBe(''))
})

describe('generateFormattedText', () => {
  it('替换变量', () => {
    const t = generateFormattedText(base({ title: '标题A', author: '作者B', like: 5 }), '标题：${标题}\n作者：${作者}\n点赞：${点赞数}')
    expect(t).toBe('标题：标题A\n作者：作者B\n点赞：5')
  })
  it('变量为空或 0 的整行自动隐藏', () => {
    const t = generateFormattedText(base({ title: '只有标题' }), '标题：${标题}\n点赞：${点赞数}')
    expect(t).toBe('标题：只有标题') // 点赞为 0，整行隐藏
  })
  it('多个结果加序号前缀', () => {
    const t = generateFormattedText(base({ title: 'X' }), '标题：${标题}', 2, 3)
    expect(t.startsWith('【2/3】')).toBe(true)
  })
})
