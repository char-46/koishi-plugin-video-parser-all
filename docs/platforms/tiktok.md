# TikTok（`tiktok`）

> 平台数据卡。本平台与所有平台共享统一解析引擎 `parseApiResponse`，差异见下。

## 基本信息

| 项 | 值 |
|---|---|
| 平台 ID | `tiktok` |
| 中文名 | TikTok（国际版抖音） |
| 解析能力 | 短视频 |
| 专属 API | 无 |
| 备用 API | 不允许 |
| 字段映射 | 全局 `globalFieldMapping`（无专属） |
| `platformEnabled` 默认 | `true` |
| `platformDedicatedFirst` 默认 | `false` |
| `customApis` 可配置 | 是 |

## 链接匹配规则

`BUILTIN_LINK_RULES` 中归属 `tiktok`（`index.ts:383-385`）：

```js
/https?:\/\/(?:www\.)?tiktok\.com\/@[\w.]+\/video\/\d{10,}/gi
/https?:\/\/vm\.tiktok\.com\/[0-9a-zA-Z_\/-]+/gi
/https?:\/\/vt\.tiktok\.com\/[0-9a-zA-Z_\/-]+/gi
```

## 解析流程时序图

无专属 API、无备用，仅主 API。

```mermaid
sequenceDiagram
    autonumber
    participant FL as flush
    participant GPC as getPlatformConfig
    participant FA as fetchApi
    participant HTTP as http(Axios)
    participant PA as parseApiResponse
    FL->>GPC: getPlatformConfig('tiktok')
    GPC-->>FL: 无专属, dedicatedFirst=false
    FL->>FA: fetchApi(url)
    Note over FA: apiList = [主API]（唯一）
    FA->>HTTP: GET 主API ?url=
    alt 成功
        HTTP-->>FA: res.data
    else 失败
        Note over FA: retryTimes 重试后抛出
    end
    FA->>PA: parseApiResponse(globalFieldMapping)
    PA-->>FL: ParsedData type=video
    Note over FL: 发送视频 + 封面 + 文字
```
