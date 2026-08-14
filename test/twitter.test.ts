import { describe, it, expect } from 'vitest'
import { parseTwitter } from '../src/platforms/twitter'
import { fetchApi } from '../src/engine/fetcher'
import { makeRuntime, mockHttp } from './helpers'

const photoTweet = {
  __typename: 'Tweet',
  text: 'Four more years. http://t.co/bAJE6Vom',
  created_at: '2012-11-07T04:16:00Z',
  favorite_count: 458034,
  conversation_count: 46905,
  user: { screen_name: 'BarackObama', name: 'Barack Obama', profile_image_url_https: 'https://pbs.twimg.com/a.jpg' },
  photos: [{ url: 'https://pbs.twimg.com/media/A7EiDWcCYAAZT1D.jpg' }],
}

const videoTweet = {
  __typename: 'Tweet',
  text: 'watch this',
  favorite_count: 10,
  user: { screen_name: 'vid', name: 'Vid' },
  videoDetails: {
    durationMs: 12300,
    viewCount: 999,
    posterUrl: 'https://pbs.twimg.com/poster.jpg',
    variants: [
      { bitrate: 832000, content_type: 'video/mp4', url: 'https://video.twimg.com/832.mp4' },
      { bitrate: 432000, content_type: 'video/mp4', url: 'https://video.twimg.com/432.mp4' },
    ],
  },
}

describe('parseTwitter — X 原生 syndication 解析', () => {
  it('从链接提取推文 ID', async () => {
    const t = await parseTwitter('https://x.com/BarackObama/status/266031293945503744', mockHttp(photoTweet))
    expect(t.uid).toBe('BarackObama')
  })

  it('图集推文：type=image，取 photos', async () => {
    const t = await parseTwitter('https://x.com/u/status/266031293945503744', mockHttp(photoTweet))
    expect(t.type).toBe('image')
    expect(t.images).toEqual(['https://pbs.twimg.com/media/A7EiDWcCYAAZT1D.jpg'])
    expect(t.cover).toBe('https://pbs.twimg.com/media/A7EiDWcCYAAZT1D.jpg')
    expect(t.like).toBe(458034)
    expect(t.comment).toBe(46905)
    expect(t.publishTime).toBe(Date.parse('2012-11-07T04:16:00Z'))
    expect(t.author).toBe('Barack Obama')
  })

  it('视频推文：按码率降序取最高', async () => {
    const t = await parseTwitter('https://x.com/u/status/266031293945503744', mockHttp(videoTweet))
    expect(t.type).toBe('video')
    expect(t.videos[0].url).toBe('https://video.twimg.com/832.mp4')
    expect(t.video).toBe('https://video.twimg.com/832.mp4')
    expect(t.cover).toBe('https://pbs.twimg.com/poster.jpg')
    expect(t.duration).toBe(12)
    expect(t.play).toBe(999)
  })

  it('tombstone（需登录/已删除）：抛出明确错误', async () => {
    const tomb = { __typename: 'TweetWithVisibilityResults', tombstone: { text: '__FIXME__LYNCHED__FIXME__' } }
    await expect(parseTwitter('https://x.com/u/status/2059244332285313260', mockHttp(tomb as any)))
      .rejects.toThrow(/不可访问|登录/)
  })

  it('非 X 链接抛出"无法提取 ID"', async () => {
    await expect(parseTwitter('https://example.com/no-id', mockHttp(photoTweet))).rejects.toThrow(/推文 ID/)
  })
})

describe('fetchApi — twitter 路由到原生解析', () => {
  it('type=twitter 且无自定义 API 时走 syndication', async () => {
    const rt = makeRuntime({ http: mockHttp(photoTweet) })
    const parsed = await fetchApi(rt, 'https://x.com/u/status/266031293945503744', 'twitter')
    expect(parsed.type).toBe('image')
    expect(parsed.images).toHaveLength(1)
  })

  it('结果写入缓存（第二次不再次请求）', async () => {
    let calls = 0
    const rt = makeRuntime({
      http: { get: async () => { calls++; return { data: photoTweet } } } as any,
    })
    await fetchApi(rt, 'https://x.com/u/status/266031293945503744', 'twitter')
    await fetchApi(rt, 'https://x.com/u/status/266031293945503744', 'twitter')
    expect(calls).toBe(1)
  })
})
