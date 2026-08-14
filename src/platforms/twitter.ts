import type { AxiosInstance } from 'axios'
import type { ParsedData, VideoQuality } from '../types'

/**
 * X / Twitter 原生解析器：使用公开的 syndication API（无需登录）。
 *
 * 背景：bugpk 统一 API 不支持 twitter（主 API 返回 "无法识别平台"），
 * 故对 twitter 走此原生路径。公开推文可直接解析；受限/需登录的推文
 * 会返回 tombstone，抛出明确错误。
 */

const SYNDICATION_URL = 'https://cdn.syndication.twimg.com/tweet-result'

function extractTweetId(url: string): string | null {
  const m = /\/status(?:es)?\/(\d+)/.exec(url)
  return m ? m[1] : null
}

function pick(...vals: any[]): any {
  for (const v of vals) if (v !== undefined && v !== null && v !== '') return v
  return ''
}

export async function parseTwitter(url: string, http: AxiosInstance): Promise<ParsedData> {
  const id = extractTweetId(url)
  if (!id) throw new Error('无法从 X 链接提取推文 ID')

  const res = await http.get(SYNDICATION_URL, {
    params: { id, token: 'a' },
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  })
  const tw = res.data
  if (!tw || tw.__typename !== 'Tweet' || !tw.user) {
    const reasonRaw = pick(tw?.tombstone?.text, tw?.tombstone?.name)
    const reason = reasonRaw ? `：${reasonRaw}` : ''
    throw new Error(`推文不可访问（可能需要登录、已被删除或为非公开内容）${reason}`)
  }

  const user = tw.user || {}
  // 长推文优先用 note_tweet
  const text = String(pick(tw.note_tweet?.text, tw.text, ''))

  // 视频
  let video = ''
  let videos: VideoQuality[] = []
  const vd = tw.videoDetails
  if (vd && Array.isArray(vd.variants) && vd.variants.length) {
    videos = vd.variants
      .filter((v: any) => v && v.url)
      .map((v: any) => ({
        quality: v.bitrate ? `${v.bitrate}bps` : (v.content_type || v.contentType || 'unknown'),
        url: v.url,
        bit_rate: Number(v.bitrate || 0),
      }))
      .sort((a: VideoQuality, b: VideoQuality) => (b.bit_rate || 0) - (a.bit_rate || 0))
    video = videos[0]?.url || ''
  }

  // 图片
  const images: string[] = Array.isArray(tw.photos)
    ? tw.photos.map((p: any) => (typeof p === 'string' ? p : p?.url)).filter((u: any) => !!u)
    : []

  const cover = String(pick(vd?.posterUrl, images[0], ''))
  const duration = vd?.durationMs ? Math.floor(Number(vd.durationMs) / 1000) : 0

  const like = Number(pick(tw.favorite_count, 0)) || 0
  const comment = Number(pick(tw.conversation_count, tw.reply_count, 0)) || 0
  const share = Number(pick(tw.retweet_count, 0)) || 0
  const play = Number(pick(vd?.viewCount, tw.views, 0)) || 0
  const collect = Number(pick(tw.bookmark_count, 0)) || 0

  let publishTime = 0
  if (tw.created_at) {
    const t = Date.parse(tw.created_at)
    if (!isNaN(t)) publishTime = t
  }

  const type = video ? 'video' : (images.length ? 'image' : 'video')

  return {
    type,
    title: text.slice(0, 100),
    desc: text,
    author: String(pick(user.name, user.screen_name, '')),
    uid: String(pick(user.screen_name, user.id_str, '')),
    avatar: String(pick(user.profile_image_url_https, user.profile_image_url, '')),
    cover,
    video,
    videos,
    images,
    live_photo: [],
    music: {},
    like,
    comment,
    collect,
    share,
    play,
    duration,
    publishTime,
    author_followers: Number(pick(user.followers_count, 0)) || 0,
    author_signature: String(pick(user.description, '')),
    admire: 0,
  }
}
