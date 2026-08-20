# 小红书（`xiaohongshu`）

> 平台数据卡。本平台与所有平台共享统一解析引擎 `parseApiResponse`，差异见下。

## 基本信息

| 项 | 值 |
|---|---|
| 平台 ID | `xiaohongshu` |
| 中文名 | 小红书 |
| 解析能力 | 图文 / 视频 |
| 专属 API | `https://api.bugpk.com/api/xhs` |
| 备用 API | **允许**（在 `backupAllowed` 白名单） |
| 字段映射 | 全局 `globalFieldMapping`（无专属） |
| `platformEnabled` 默认 | `true` |
| `platformDedicatedFirst` 默认 | `false` |
| `customApis` 可配置 | 是 |

## 链接匹配规则

`BUILTIN_LINK_RULES` 中归属 `xiaohongshu`（`platforms/rules.ts`）：

```js
/https?:\/\/(?:www\.)?xiaohongshu\.com\/discovery\/item\/[0-9a-zA-Z_\/-]+/gi
/https?:\/\/xhslink\.com\/[0-9a-zA-Z_\/-]+/gi
/https?:\/\/(?:www\.)?xiaohongshu\.com\/explore\/[0-9a-zA-Z_\/-]+/gi
/https?:\/\/(?:www\.)?xiaohongshu\.com\/board\/[0-9a-zA-Z_\/-]+/gi
```

## 解析流程时序图

`dedicatedFirst=false`（默认），顺序：主 API → 备用 API → 专属 API。

```mermaid
sequenceDiagram
    autonumber
    participant FL as flush
    participant GPC as getPlatformConfig
    participant FA as fetchApi
    participant HTTP as http(Axios)
    participant PA as parseApiResponse
    FL->>GPC: getPlatformConfig('xiaohongshu')
    GPC-->>FL: dedicatedFirst=false<br/>专属=xhs API, 备用允许
    FL->>FA: fetchApi(url)
    Note over FA: apiList = [主API, 备用API, 专属xhs]
    FA->>HTTP: GET 主API ?url=
    alt 主API 成功
        HTTP-->>FA: res.data
    else 失败
        FA->>HTTP: GET 备用API ?url=
        alt 备用成功
            HTTP-->>FA: res.data
        else 失败
            FA->>HTTP: GET 专属 xhs ?url=
            HTTP-->>FA: res.data
        end
    end
    FA->>PA: parseApiResponse(globalFieldMapping)
    PA-->>FL: ParsedData type=image/video
    Note over FL: image→图文图片；video→视频
```
