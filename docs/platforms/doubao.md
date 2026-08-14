# 豆包（视频）（`doubao`）

> 平台数据卡。本平台与所有平台共享统一解析引擎 `parseApiResponse`，差异见下。

## 基本信息

| 项 | 值 |
|---|---|
| 平台 ID | `doubao` |
| 中文名 | 豆包（视频） |
| 解析能力 | 视频 |
| 专属 API | `https://api.bugpk.com/api/dbvideos` |
| 备用 API | 不允许 |
| 字段映射 | 全局 `globalFieldMapping`（无专属） |
| `platformEnabled` 默认 | `true` |
| `platformDedicatedFirst` 默认 | `false` |
| `customApis` 可配置 | 是 |

## 链接匹配规则

`BUILTIN_LINK_RULES` 中归属 `doubao`（`index.ts:400-401`）：

```js
/https?:\/\/(?:www\.)?doubao\.com\/video\/\d{10,}/gi
/https?:\/\/(?:www\.)?doubao\.com\/video-sharing\?[^\s'"“”‘’]*/gi
```

## 解析流程时序图

`dedicatedFirst=false`（默认），顺序：主 API → 专属 API（无备用）。

```mermaid
sequenceDiagram
    autonumber
    participant FL as flush
    participant GPC as getPlatformConfig
    participant FA as fetchApi
    participant HTTP as http(Axios)
    participant PA as parseApiResponse
    FL->>GPC: getPlatformConfig('doubao')
    GPC-->>FL: dedicatedFirst=false<br/>专属=dbvideos API
    FL->>FA: fetchApi(url)
    Note over FA: apiList = [主API, 专属dbvideos]
    FA->>HTTP: GET 主API ?url=
    alt 主API 成功
        HTTP-->>FA: res.data
    else 主API 失败
        FA->>HTTP: GET 专属 dbvideos ?url=
        HTTP-->>FA: res.data
    end
    FA->>PA: parseApiResponse(globalFieldMapping)
    PA-->>FL: ParsedData type=video
    Note over FL: 发送视频 + 封面 + 文字
```
