# Twitter / X（`twitter`）

> 平台数据卡。X **不走 bugpk 统一 API**（统一 API 不支持 twitter），改用原生 syndication 解析器。

## 基本信息

| 项 | 值 |
|---|---|
| 平台 ID | `twitter` |
| 中文名 | Twitter / X |
| 解析能力 | 视频 / 图文 |
| 解析方式 | **原生 syndication API**（`platforms/twitter.ts`，无需登录即可解析公开推文） |
| bugpk 统一 API | ✗ 不支持（主 API 返回"无法识别平台"） |
| 备用 API | 不允许 |
| 字段映射 | 不适用（原生解析直接构造 `ParsedData`） |
| `platformEnabled` 默认 | `true` |
| `platformDedicatedFirst` 默认 | `false` |
| `customApis` 可配置 | 是（若配置则覆盖原生解析，走自定义 API） |

> ⚠️ **登录限制与 Cloudflare 指纹墙**：X 的 syndication API 仅返回**公开**推文（忽略 cookie）。对需登录的推文，插件提供 **GraphQL 鉴权回退**（`TweetResultByRestId`，仅用 `auth_token` + `ct0` 两个 cookie，最小化）。
>
> 但 X 的 GraphQL 端点受 **Cloudflare TLS 指纹校验**保护：服务端 Node/axios 的 TLS 握手(JA3/JA4)与 Chrome 不同，会被 CF 直接 **403**（cookie 到不了应用层，实测 guest 流程打公开推文也 403）。因此该回退仅在 **TLS 指纹模拟环境**（`curl-impersonate` / Puppeteer / 浏览器 / 指纹代理）下生效。
>
> **配置**（可选）：插件 `twitterAuthToken` + `twitterCt0`；CLI `--twitter-auth-token` + `--twitter-ct0`。提供后，遇到 tombstone 会尝试 GraphQL；纯 Node 下会返回明确的 403 错误。

## 链接匹配规则

`BUILTIN_LINK_RULES` 中归属 `twitter`（`platforms/rules.ts`）：

```js
/https?:\/\/twitter\.com\/\w+\/status\/\d{10,}/gi
/https?:\/\/x\.com\/\w+\/status\/\d{10,}/gi
```

> 注意：规则要求状态 ID 至少 10 位数字（真实推文 ID 为 18~19 位）。

## 解析流程时序图

`fetchApi` 检测到 `type === 'twitter'` 且用户未自定义 API 时，路由到 `parseTwitter` 原生解析。

```mermaid
sequenceDiagram
    autonumber
    participant FL as flush
    participant FA as fetchApi
    participant PT as parseTwitter
    participant SYN as syndication API
    FL->>FA: fetchApi(url, 'twitter')
    FA->>FA: 检查缓存
    FA->>PT: parseTwitter(url, http)
    PT->>PT: 提取推文 ID (/status/(\d+))
    PT->>SYN: GET cdn.syndication.twimg.com<br/>/tweet-result?id=...&token=a
    alt 公开推文
        SYN-->>PT: {text, user, photos, videoDetails, ...}
        PT->>PT: mapSyndication 构造 ParsedData
        PT-->>FA: ParsedData
        FA->>FA: 写入缓存
        FA-->>FL: 成功 (video/image)
    else tombstone（受限/需登录）
        SYN-->>PT: {tombstone, ...}
        opt 提供了 auth_token + ct0
            PT->>GQL: GET x.com/i/api/graphql/.../TweetResultByRestId<br/>cookie: auth_token; ct0 + bearer + x-csrf
            alt TLS 指纹通过（curl-impersonate/浏览器）
                GQL-->>PT: {data.tweetResult.result}
                PT->>PT: mapGraphql 构造 ParsedData
                PT-->>FA: 成功
            else 纯 Node（TLS 指纹不符）
                GQL-->>PT: 403 Cloudflare
                PT-->>FA: throw "Cloudflare 指纹拦截"
            end
        end
        opt 未提供 cookie
            PT-->>FA: throw "推文不可访问（需登录）"
        end
    end
```

## 字段映射

**syndication → ParsedData**

| syndication 字段 | ParsedData 字段 |
|-----------------|-----------------|
| `text` / `note_tweet.text` | `title`（前 100 字）+ `desc` |
| `user.screen_name` | `uid` |
| `user.name` | `author` |
| `user.profile_image_url_https` | `avatar` |
| `user.followers_count` / `description` | `author_followers` / `author_signature` |
| `photos[].url` | `images` |
| `videoDetails.variants[]`（按 bitrate 降序） | `videos` + `video`（最高码率） |
| `videoDetails.posterUrl` | `cover` |
| `videoDetails.durationMs` | `duration`（秒） |
| `videoDetails.viewCount` | `play` |
| `favorite_count` / `conversation_count` / `retweet_count` | `like` / `comment` / `share` |
| `created_at`（ISO） | `publishTime`（毫秒） |

**GraphQL TweetResultByRestId → ParsedData**

| GraphQL 字段 | ParsedData 字段 |
|--------------|-----------------|
| `legacy.full_text` / `note_tweet...text` | `title` + `desc` |
| `core.user_results.result.legacy.screen_name` | `uid` |
| `core.user_results.result.legacy.name` | `author` |
| `legacy.entities.media[type=photo].media_url_https` | `images` |
| `legacy.entities.media[type=video].video_info.variants`（mp4，按 bitrate 降序） | `videos` + `video` |
| `media.media_url_https` | `cover`（视频海报） |
| `result.views.count` | `play` |
| `legacy.favorite_count` / `reply_count` / `retweet_count` / `bookmark_count` | `like` / `comment` / `share` / `collect` |
| `legacy.created_at`（RFC822） | `publishTime`（毫秒） |
