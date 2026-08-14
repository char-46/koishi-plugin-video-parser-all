import type { AxiosInstance } from 'axios'
import type { ParsedData, VideoQuality } from '../types'

/**
 * X / Twitter 原生解析器。
 *
 * - 公开推文：走 syndication API（cdn.syndication.twimg.com），无需登录，Node 友好。
 * - 需登录推文（syndication 返回 tombstone）：若提供 {authToken, ct0}，回退到
 *   GraphQL TweetResultByRestId（仅用 auth_token + ct0 两个 cookie，最小化）。
 *
 * ⚠️ 重要限制：X 的 GraphQL 端点受 Cloudflare TLS 指纹校验保护。纯 Node/axios 的
 * TLS 握手(JA3/JA4)与 Chrome 不同，会被 CF 直接 403（cookie 到不了应用层）。
 * 因此登录态回退仅在「TLS 指纹模拟环境」（curl-impersonate / 浏览器 / 代理）下生效；
 * 在普通 Node 中会返回 403 并抛出明确错误。
 */

const SYNDICATION_URL = 'https://cdn.syndication.twimg.com/tweet-result'

// X 网页端公开 bearer（抓包固定值，非密钥）
const WEB_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
// TweetResultByRestId 的 queryId（随 web 版本变动，可被覆盖）
const TWEET_RESULT_QUERY_ID = 'GZsN2Pc4knAoit6pXa4HSA'
const GRAPHQL_FEATURES = {
  creator_subscriptions_tweet_preview_api_enabled: true,
  communities_web_enable_tweet_community_results_fetch: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
}

export interface TwitterCreds {
  authToken: string
  ct0: string
}

function extractTweetId(url: string): string | null {
  const m = /\/status(?:es)?\/(\d+)/.exec(url)
  return m ? m[1] : null
}

function pick(...vals: any[]): any {
  for (const v of vals) if (v !== undefined && v !== null && v !== '') return v
  return ''
}

function baseParsed(): ParsedData {
  return {
    type: 'video', title: '', desc: '', author: '', uid: '', avatar: '', cover: '',
    video: '', videos: [], images: [], live_photo: [], music: {},
    like: 0, comment: 0, collect: 0, share: 0, play: 0, duration: 0, publishTime: 0,
    author_followers: 0, author_signature: '', admire: 0,
  }
}

/** 把 syndication 响应映射为 ParsedData */
function mapSyndication(tw: any): ParsedData {
  const user = tw.user || {}
  const text = String(pick(tw.note_tweet?.text, tw.text, ''))
  const p = baseParsed()

  const vd = tw.videoDetails
  if (vd && Array.isArray(vd.variants) && vd.variants.length) {
    p.videos = vd.variants
      .filter((v: any) => v && v.url)
      .map((v: any) => ({ quality: v.bitrate ? `${v.bitrate}bps` : (v.content_type || 'unknown'), url: v.url, bit_rate: Number(v.bitrate || 0) }))
      .sort((a: VideoQuality, b: VideoQuality) => (b.bit_rate || 0) - (a.bit_rate || 0))
    p.video = p.videos[0]?.url || ''
  }
  p.images = Array.isArray(tw.photos) ? tw.photos.map((x: any) => (typeof x === 'string' ? x : x?.url)).filter((u: any) => !!u) : []
  p.cover = String(pick(vd?.posterUrl, p.images[0], ''))
  p.duration = vd?.durationMs ? Math.floor(Number(vd.durationMs) / 1000) : 0
  p.type = p.video ? 'video' : (p.images.length ? 'image' : 'video')

  p.title = text.slice(0, 100)
  p.desc = text
  p.author = String(pick(user.name, user.screen_name, ''))
  p.uid = String(pick(user.screen_name, user.id_str, ''))
  p.avatar = String(pick(user.profile_image_url_https, user.profile_image_url, ''))
  p.like = Number(pick(tw.favorite_count, 0)) || 0
  p.comment = Number(pick(tw.conversation_count, tw.reply_count, 0)) || 0
  p.share = Number(pick(tw.retweet_count, 0)) || 0
  p.play = Number(pick(vd?.viewCount, tw.views, 0)) || 0
  p.collect = Number(pick(tw.bookmark_count, 0)) || 0
  if (tw.created_at) { const t = Date.parse(tw.created_at); if (!isNaN(t)) p.publishTime = t }
  p.author_followers = Number(pick(user.followers_count, 0)) || 0
  p.author_signature = String(pick(user.description, ''))
  return p
}

/** 把 GraphQL TweetResultByRestId 响应映射为 ParsedData */
function mapGraphql(result: any): ParsedData {
  const legacy = result.legacy || {}
  const user = result.core?.user_results?.result
  const ulegacy = user?.legacy || {}
  const text = String(pick(legacy.full_text, result.note_tweet?.note_results?.note?.text, ''))
  const p = baseParsed()

  const media = Array.isArray(legacy.entities?.media) ? legacy.entities.media : []
  const photos: string[] = []
  for (const m of media) {
    if (!m) continue
    if (m.type === 'photo') {
      if (m.media_url_https) photos.push(m.media_url_https)
    } else if ((m.type === 'video' || m.type === 'animated_gif') && m.video_info?.variants?.length) {
      const vs = m.video_info.variants
        .filter((v: any) => v && v.url && (v.content_type || '').includes('mp4'))
        .map((v: any) => ({ quality: v.bitrate ? `${v.bitrate}bps` : 'unknown', url: v.url, bit_rate: Number(v.bitrate || 0) }))
        .sort((a: VideoQuality, b: VideoQuality) => (b.bit_rate || 0) - (a.bit_rate || 0))
      if (vs.length) {
        p.videos.push(...vs)
        if (!p.video) {
          p.video = vs[0].url
          p.cover = String(pick(m.media_url_https, p.cover))
          if (m.video_info.duration_millis) p.duration = Math.floor(Number(m.video_info.duration_millis) / 1000)
        }
      }
    }
  }
  p.images = photos
  if (!p.cover) p.cover = String(pick(photos[0], ''))
  p.type = p.video ? 'video' : (p.images.length ? 'image' : 'video')

  p.title = text.slice(0, 100)
  p.desc = text
  p.author = String(pick(ulegacy.name, ulegacy.screen_name, ''))
  p.uid = String(pick(ulegacy.screen_name, user?.rest_id, ''))
  p.avatar = String(pick(ulegacy.profile_image_url_https, ''))
  p.like = Number(pick(legacy.favorite_count, 0)) || 0
  p.comment = Number(pick(legacy.reply_count, 0)) || 0
  p.share = Number(pick(legacy.retweet_count, 0)) || 0
  p.play = Number(pick(result.views?.count, 0)) || 0
  p.collect = Number(pick(legacy.bookmark_count, 0)) || 0
  if (legacy.created_at) { const t = Date.parse(legacy.created_at); if (!isNaN(t)) p.publishTime = t }
  p.author_followers = Number(pick(ulegacy.followers_count, 0)) || 0
  p.author_signature = String(pick(ulegacy.description, ''))
  return p
}

/** 鉴权 GraphQL：仅用 auth_token + ct0，回退取登录受限推文 */
async function fetchGraphqlTweet(http: AxiosInstance, id: string, creds: TwitterCreds): Promise<ParsedData> {
  const variables = { tweetId: id, includePromotedContent: true, withBirdwatchNotes: true, withVoice: true, withCommunity: true }
  const url = `https://x.com/i/api/graphql/${TWEET_RESULT_QUERY_ID}/TweetResultByRestId`
  let res
  try {
    res = await http.get(url, {
      params: { variables: JSON.stringify(variables), features: JSON.stringify(GRAPHQL_FEATURES) },
      timeout: 30000,
      validateStatus: () => true,
      headers: {
        authorization: WEB_BEARER,
        'x-csrf-token': creds.ct0,
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
        'x-twitter-client-language': 'en',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
        cookie: `auth_token=${creds.authToken}; ct0=${creds.ct0}`,
      },
    })
  } catch (e: any) {
    throw new Error(`X GraphQL 请求失败：${e?.message || e}（需登录的推文）`)
  }

  if (res.status === 403 || res.status === 429) {
    throw new Error(
      `X GraphQL 被 Cloudflare 拦截 (HTTP ${res.status})：服务端 Node 的 TLS 指纹与浏览器不同，` +
      `cookie 无法抵达应用层。需在 TLS 指纹模拟环境（如 curl-impersonate / Puppeteer / 代理）运行才能解析需登录推文。`
    )
  }
  if (res.status !== 200) {
    throw new Error(`X GraphQL 返回 HTTP ${res.status}：${typeof res.data === 'string' ? res.data.slice(0, 120) : JSON.stringify(res.data || {}).slice(0, 120)}`)
  }

  const result = res.data?.data?.tweetResult?.result
  if (!result || ['TweetTombstone', 'TweetUnavailable', 'TweetWithVisibilityResults'].includes(result.__typename) && !result.legacy) {
    const tb = result?.tombstone?.text?.text || result?.tombstone?.text
    throw new Error(`推文不可访问（可能需要登录、已被删除或为非公开内容）${tb ? '：' + tb : ''}`)
  }
  return mapGraphql(result)
}

export async function parseTwitter(url: string, http: AxiosInstance, creds?: TwitterCreds): Promise<ParsedData> {
  const id = extractTweetId(url)
  if (!id) throw new Error('无法从 X 链接提取推文 ID')

  // 1) 公开 syndication 路径
  const res = await http.get(SYNDICATION_URL, {
    params: { id, token: 'a' },
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  })
  const tw = res.data
  if (tw && tw.__typename === 'Tweet' && tw.user) {
    return mapSyndication(tw)
  }

  // 2) tombstone（需登录）：回退到鉴权 GraphQL
  if (creds && creds.authToken && creds.ct0) {
    return fetchGraphqlTweet(http, id, creds)
  }
  const reasonRaw = pick(tw?.tombstone?.text, tw?.tombstone?.name)
  throw new Error(`推文不可访问（可能需要登录、已被删除或为非公开内容）${reasonRaw ? '：' + reasonRaw : ''}`)
}
