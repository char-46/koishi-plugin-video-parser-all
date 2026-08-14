# 即梦（`jimeng`）

> 平台数据卡。本平台与所有平台共享统一解析引擎 `parseApiResponse`，差异见下。

## 基本信息

| 项 | 值 |
|---|---|
| 平台 ID | `jimeng` |
| 中文名 | 即梦（AI 视频 / AI 图片，Dreamina） |
| 解析能力 | AI 视频 / AI 图片 |
| 专属 API | `https://api.bugpk.com/api/jimengai` |
| 备用 API | **允许**（在 `backupAllowed` 白名单） |
| 字段映射 | 全局 `globalFieldMapping`（无专属） |
| `platformEnabled` 默认 | ⚠️ **缺失**（不在开关表，`?? true` 兜底为启用） |
| `platformDedicatedFirst` 默认 | ⚠️ **缺失**（不在开关表，`?? false` 兜底为 false） |
| `customApis` 可配置 | ⚠️ 缺失（不在 `customApis.platform` 枚举） |

> ⚠️ 数据不一致：`jimeng` 在链接规则、专属 API、备用白名单中均存在，但缺失于 `platformEnabled` / `platformDedicatedFirst` / `customApis` 三处。用户无法通过 UI 单独开关或配置自定义 API。**拆分阶段将修正**。

## 链接匹配规则

`BUILTIN_LINK_RULES` 中归属 `jimeng`（`index.ts:403-406`）：

```js
/https?:\/\/(?:www\.)?jimeng\.jianying\.com\/[^\s'"“”‘’]*/gi
/https?:\/\/(?:www\.)?jimeng\.cn\/[^\s'"“”‘’]*/gi
/https?:\/\/(?:www\.)?dreamina\.jianying\.com\/[^\s'"“”‘’]*/gi
/https?:\/\/(?:www\.)?dreamina\.capcut\.com\/[^\s'"“”‘’]*/gi
```

## 解析流程时序图

`dedicatedFirst` 兜底为 `false`，顺序：主 API → 备用 API → 专属 API。

```mermaid
sequenceDiagram
    autonumber
    participant FL as flush
    participant GPC as getPlatformConfig
    participant FA as fetchApi
    participant HTTP as http(Axios)
    participant PA as parseApiResponse
    FL->>GPC: getPlatformConfig('jimeng')
    GPC-->>FL: dedicatedFirst=false(兜底)<br/>专属=jimengai, 备用允许
    FL->>FA: fetchApi(url)
    Note over FA: apiList = [主API, 备用API, 专属jimengai]
    FA->>HTTP: GET 主API ?url=
    alt 主API 成功
        HTTP-->>FA: res.data
    else 失败
        FA->>HTTP: GET 备用API ?url=
        alt 备用成功
            HTTP-->>FA: res.data
        else 失败
            FA->>HTTP: GET 专属 jimengai ?url=
            HTTP-->>FA: res.data
        end
    end
    FA->>PA: parseApiResponse(globalFieldMapping)
    PA-->>FL: ParsedData type=video/image
    Note over FL: video→AI视频；image→AI图片集
```
