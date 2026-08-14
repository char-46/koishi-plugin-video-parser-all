# 通用时序图

完整描述一次视频/图集解析的端到端流程。涵盖：消息接收 → 链接匹配 → 平台识别 → 并发限流 → 去重 → API 调用与重试 → 字段映射 → 缓存 → 结果发送（普通 / 合并转发）。

源码位置：`src/`（拆分后的多模块结构）。

## 模块归属速查

| 流程步骤 | 模块文件 |
|----------|----------|
| 事件入口 / 命令注册 / dispose | `index.ts` |
| 运行期状态构建 | `runtime.ts`（`createRuntime`） |
| 链接匹配 `extractAllUrlsFromMessage` / `linkTypeParser` / `cleanUrl` | `utils/url.ts` |
| 平台配置查询 `getPlatformConfig` | `platforms/custom.ts` |
| 链接规则 `BUILTIN_LINK_RULES` | `platforms/rules.ts` |
| 专属 API 表 `defaultDedicatedApis` | `platforms/dedicated-apis.ts` |
| 解析编排 `flush` / `processSingleUrl` / `parseUrl` / `fetchApi` | `sender/flush.ts` + `engine/fetcher.ts` |
| 统一解析引擎 `parseApiResponse` | `engine/parser.ts` |
| 缓存 / 并发 / 去重 | `utils/cache.ts` + `utils/concurrency.ts` + `utils/common.ts` |
| 字段映射 `getNestedValue` / `parseFieldMapping` | `utils/field-mapping.ts` |
| 文字格式化 `generateFormattedText` | `utils/format.ts` |
| 发送 `sendWithTimeout` / `sendMedia` / `buildForwardNode` | `sender/sender.ts` + `sender/forward.ts` |
| 文案兜底 `getText` | `utils/common.ts` |

## 主流程时序图

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户
    participant S as Session
    participant EH as apply:message<br/>(事件入口)
    participant EX as extractAllUrls<br/>FromMessage
    participant LT as linkTypeParser
    participant FL as flush
    participant CL as ConcurrencyLimiter
    participant FA as fetchApi
    participant PA as parseApiResponse
    participant HTTP as http(Axios)
    participant SM as sendMedia /<br/>sendWithTimeout

    U->>S: 发送含视频链接的消息
    S->>EH: 触发 message 事件

    Note over EH: 过滤：插件禁用 / parse 命令 /<br/>文件上传 / 自身消息 → return
    EH->>EX: extractAllUrlsFromMessage(session, customRules)
    EX->>LT: linkTypeParser(content, rules)
    LT-->>EX: LinkMatch[] {type,url,id}
    Note over EX: 另解析 xml/json 卡片<br/>(QQ 小程序分享)，cleanUrl 去重
    EX-->>EH: matches: LinkMatch[]

    alt 无匹配
        EH-->>S: return（静默）
    end

    opt showWaitingTip = true
        EH->>SM: sendWithTimeout(quote + waitingTipText)
    end

    EH->>FL: flush(session, matches)
```

## flush 内部：并发、去重、解析、发送

```mermaid
sequenceDiagram
    autonumber
    participant FL as flush
    participant CL as ConcurrencyLimiter
    participant DC as dedupCache<br/>(URL 去重)
    participant CDC as contentDedupCache<br/>(内容去重)
    participant GPC as getPlatformConfig
    participant PSU as processSingleUrl
    participant FA as fetchApi
    participant UC as urlCacheLocal<br/>(结果缓存)
    participant HTTP as http(Axios)
    participant PA as parseApiResponse
    participant GFT as generateFormattedText
    participant SM as sendMedia /<br/>sendWithTimeout

    loop 每个 match（并发上限 = maxConcurrent）
        FL->>CL: acquire()
        FL->>FL: 检查 platformEnabled[type]

        opt enableDeduplication 且 deduplicationInterval > 0
            FL->>DC: get(url)
            alt 命中（interval 内）
                FL->>SM: sendWithTimeout(deduplicationTipText)
                Note over FL: 跳过此链接
            end
        end

        FL->>GPC: getPlatformConfig(type)
        GPC-->>FL: {apiUrl, dedicatedFirst, apiKey,<br/>authHeaderType, fieldMapping, customProxy}

        FL->>PSU: processSingleUrl(url, type, fieldMapping, conf)
        PSU->>FA: fetchApi(url, type, fieldMapping, conf)
        FA->>UC: get(url)
        alt 缓存命中且未过期
            UC-->>FA: 返回缓存 ParsedData
        else 缓存未命中
            FA->>FA: 构建 apiList（见下方"API 选择"）
            loop 遍历 apiList（逐 API）
                loop retryTimes + 1 次
                    FA->>HTTP: http.get(api.url, {params:{url},<br/>headers, proxy, timeout})
                    alt code === 200 或 0
                        HTTP-->>FA: res.data
                        FA->>PA: parseApiResponse(res.data,<br/>maxDescLength, fieldMapping)
                        Note over PA: mapField(fieldMapping) +<br/>多字段 fallback 容错
                        PA-->>FA: ParsedData
                        FA->>UC: set(url, {data, expire})
                        FA-->>PSU: ParsedData
                    else 网络错误 / 5xx / 429
                        Note over FA: 等待 retryInterval 后重试
                    else 其他错误
                        Note over FA: break → 下一个 API
                    end
                end
            end
        end

        PSU-->>FL: {success, data:{text, parsed}} | {success:false, msg}

        opt 解析成功 且 enableDeduplication
            FL->>CDC: get(contentFingerprint(parsed))
            alt 内容指纹命中
                Note over FL: 跳过重复内容（不发送）
            else 未命中
                FL->>CDC: set(fp, now)
                FL->>DC: set(url, now)
            end
        end

        FL->>CL: release()
    end

    opt 有错误
        FL->>SM: sendWithTimeout(parseErrorPrefix + errors)
    end
    opt 无成功项
        FL-->>EH: return
    end
```

## API 选择逻辑（fetchApi 内 apiList 构建）

顺序由 `getPlatformConfig().dedicatedFirst`（来自 `config.platformDedicatedFirst[type]`）决定：

```mermaid
flowchart LR
    Start([dedicatedFirst?]) --> Q1{dedicatedFirst<br/>= true?}
    Q1 -->|是| A1[专属 API]
    A1 --> A2[默认主 API]
    A2 --> A3{backupAllowed?<br/>douyin/xhs/<br/>instagram/jimeng}
    A3 -->|是| A4[备用主 API]
    A3 -->|否| End1([结束])
    A4 --> End1

    Q1 -->|否| B1[默认主 API]
    B1 --> B2{backupAllowed?}
    B2 -->|是| B3[备用主 API]
    B2 -->|否| B4[专属 API]
    B3 --> B4
    B4 --> End2([结束])

    style A1 fill:#fde68a
    style B4 fill:#fde68a
    style A3 fill:#bfdbfe
    style B2 fill:#bfdbfe
```

> 自定义平台（`custom_*`）强制 `dedicatedFirst = true`，仅使用其自定义 `apiUrl`。

## 结果发送分支

```mermaid
flowchart TD
    S([flush 收集到 items])
    S --> F{enableForward<br/>且平台为<br/>onebot/satori?}

    F -->|是 合并转发| FW[为每个 item 构建多个 h node]
    FW --> FW2[文字 → 作者头像 → 封面 →<br/>音乐封面 → 图集/实况 → 视频 → 音乐语音]
    FW2 --> FW3[按 MAX_NODES=50 分批]
    FW3 --> FW4{转发成功?}
    FW4 -->|失败| FW5[降级：逐条发送 node 内容]
    FW4 -->|成功| END([完成])

    F -->|否 普通逐条| NM[每个 item 依次发送]
    NM --> NM2[文字 → delay300 →<br/>头像 → delay300 →<br/>封面+提示 → delay300 →<br/>音乐封面 → delay300 →<br/>图集/实况 delay500~1000 →<br/>直播提示 →<br/>音乐语音 delay300]
    NM2 --> END

    style FW fill:#dbeafe
    style NM fill:#fef3c7
    style FW5 fill:#fecaca
```

## 媒体发送决策（sendMedia）

| 条件 | 行为 |
|------|------|
| `showFile = false`（如 `showCoverFile`/`showImageFileNew`/`showAuthorAvatarFile`/`showMusicVoiceFile` 关闭） | 仅发送 `{类型}链接：{url}` 文本 |
| `showFile = true` 且发送 `h.image/h.video/h.audio` 成功 | 发送媒体元素 |
| `showFile = true` 但发送抛错 | 回退发送 `{类型}链接：{url}` 文本 |

## 关键配置项映射

| 阶段 | 相关配置 |
|------|---------|
| 过滤 | `enable`, `showWaitingTip` |
| 匹配 | `customPlatforms`（生成 customRules） |
| 并发 | `maxConcurrent` |
| 去重 | `enableDeduplication`, `deduplicationInterval` |
| 平台开关 | `platformEnabled[type]` |
| API 选择 | `platformDedicatedFirst[type]`, `customApis`, `primaryApiUrl`, `backupApiUrl` |
| 请求 | `timeout`, `userAgent`, `proxy`, `customHeaders`, `retryTimes`, `retryInterval` |
| 字段映射 | `globalFieldMapping`, `customApis[].fieldMapping`, `customPlatforms[].fieldMapping` |
| 缓存 | `cacheTTL` |
| 格式化 | `unifiedMessageFormat`, `maxDescLength` |
| 发送 | `enableForward`, `showImageText`, `showCoverImage/File/Text`, `showImageFileNew`, `showAuthorAvatar/File/Text`, `showMusicCover`, `showVideoFile`, `showMusicVoice/File`, `sendLiveMessage`, `ignoreSendError`, `videoSendTimeout`, `botName` |
