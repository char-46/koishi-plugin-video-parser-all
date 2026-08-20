# AcFun / A站（`acfun`）

> 平台数据卡。本平台与所有平台共享统一解析引擎 `parseApiResponse`，差异见下。

## 基本信息

| 项 | 值 |
|---|---|
| 平台 ID | `acfun` |
| 中文名 | AcFun（A站） |
| 解析能力 | 视频 |
| 专属 API | 无 |
| 备用 API | 不允许 |
| 字段映射 | 全局 `globalFieldMapping`（无专属） |
| `platformEnabled` 默认 | `true` |
| `platformDedicatedFirst` 默认 | `false` |
| `customApis` 可配置 | 是 |

## 链接匹配规则

`BUILTIN_LINK_RULES` 中归属 `acfun`（`platforms/rules.ts`）：

```js
/https?:\/\/(?:www\.)?acfun\.cn\/v\/ac\d{10,}/gi
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
    FL->>GPC: getPlatformConfig('acfun')
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
