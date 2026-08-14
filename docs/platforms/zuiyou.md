# 最右（`zuiyou`）

> 平台数据卡。本平台与所有平台共享统一解析引擎 `parseApiResponse`，差异见下。

## 基本信息

| 项 | 值 |
|---|---|
| 平台 ID | `zuiyou` |
| 中文名 | 最右 |
| 解析能力 | 短视频 |
| 专属 API | `https://api.bugpk.com/api/zuiyou` |
| 备用 API | 不允许 |
| 字段映射 | 全局 `globalFieldMapping`（无专属） |
| `platformEnabled` 默认 | `true` |
| `platformDedicatedFirst` 默认 | `false` |
| `customApis` 可配置 | ⚠️ 缺失（不在 `customApis.platform` 枚举，UI 无法选择） |

## 链接匹配规则

`BUILTIN_LINK_RULES` 中归属 `zuiyou`（`index.ts:418-419`）：

```js
/https?:\/\/share\.xiaochuankeji\.cn\/hybrid\/share\/post\?pid=\d+/gi
/https?:\/\/(?:h5|www)\.izuiyou\.com\/[0-9a-zA-Z_\/-]+/gi
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
    FL->>GPC: getPlatformConfig('zuiyou')
    GPC-->>FL: dedicatedFirst=false<br/>专属=zuiyou API
    FL->>FA: fetchApi(url)
    Note over FA: apiList = [主API, 专属zuiyou]
    FA->>HTTP: GET 主API ?url=
    alt 主API 成功
        HTTP-->>FA: res.data
    else 主API 失败
        FA->>HTTP: GET 专属 zuiyou ?url=
        HTTP-->>FA: res.data
    end
    FA->>PA: parseApiResponse(globalFieldMapping)
    PA-->>FL: ParsedData type=video
    Note over FL: 发送视频 + 封面 + 文字
```
