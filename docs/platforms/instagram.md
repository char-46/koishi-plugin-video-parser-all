# Instagram（`instagram`）

> 平台数据卡。本平台与所有平台共享统一解析引擎 `parseApiResponse`，差异见下。

## 基本信息

| 项 | 值 |
|---|---|
| 平台 ID | `instagram` |
| 中文名 | Instagram |
| 解析能力 | 图文 / Reels |
| 专属 API | 无 |
| 备用 API | **允许**（在 `backupAllowed` 白名单，但无专属） |
| 字段映射 | 全局 `globalFieldMapping`（无专属） |
| `platformEnabled` 默认 | `true` |
| `platformDedicatedFirst` 默认 | `false` |
| `customApis` 可配置 | 是 |

## 链接匹配规则

`BUILTIN_LINK_RULES` 中归属 `instagram`（`platforms/rules.ts`）：

```js
/https?:\/\/(?:www\.)?instagram\.com\/p\/[0-9a-zA-Z_\/-]+/gi
/https?:\/\/(?:www\.)?instagram\.com\/reel\/[0-9a-zA-Z_\/-]+/gi
/https?:\/\/(?:www\.)?instagram\.com\/share\/(?:reel|p)\/[0-9a-zA-Z_\/-]+/gi
```

## 解析流程时序图

无专属 API，但允许备用，顺序：主 API → 备用 API。

```mermaid
sequenceDiagram
    autonumber
    participant FL as flush
    participant GPC as getPlatformConfig
    participant FA as fetchApi
    participant HTTP as http(Axios)
    participant PA as parseApiResponse
    FL->>GPC: getPlatformConfig('instagram')
    GPC-->>FL: 无专属, 备用允许, dedicatedFirst=false
    FL->>FA: fetchApi(url)
    Note over FA: apiList = [主API, 备用API]
    FA->>HTTP: GET 主API ?url=
    alt 主API 成功
        HTTP-->>FA: res.data
    else 主API 失败
        FA->>HTTP: GET 备用API ?url=
        HTTP-->>FA: res.data
    end
    FA->>PA: parseApiResponse(globalFieldMapping)
    PA-->>FL: ParsedData type=image/video
    Note over FL: image→图文图片；video→Reels 视频
```
