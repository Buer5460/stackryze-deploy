# REAL_DATA_IMPORT_GUIDE — 真实学校数据导入指南

> 适用版本：V1.0（2026-09-23）
> 面向：平台运营 / 数据录入人员
> 核心原则：**每条真实学校数据必须可追溯来源；缺少来源的数据永远无法被标记为 verified。**

## 1. 两种操作方式

### 方式 A：管理后台 H5（推荐）
1. 首页右上角「切换角色」→ 选择 **平台管理后台**。
2. 底部导航进入 **「✓ 数据审核」**。
3. 在「真实数据导入」文本框粘贴 CSV 或 JSON → 点 **「预览校验」** 检查每行报告 → 无误后点 **「批量导入」**。
4. 导入的学校以 `draft` 状态进入上方审核队列，逐条审核。

### 方式 B：API（适合批量脚本）
```
POST /api/admin/import/preview    # 预览，不入库
POST /api/admin/import/commit     # 批量导入，入审核队列
Header: x-role: admin
Body:   { "content": "<CSV 或 JSON 文本>" }
```

## 2. 数据格式

### CSV（首行为表头，逗号分隔；字段顺序不限）
```csv
name,name_en,country,city,district,institution_type,stages,curricula,main_language,tuition_min,tuition_max,currency,boarding,scholarships,latitude,longitude,source_url,verified_status,verified_at,effective_from,effective_to
莱佛士女子中学,Raffles Girls School,Singapore,Singapore,SG-SIN-NOVENA,Secondary School,lower-secondary;upper-secondary,Singapore-Cambridge O Level,English,,,,false,false,1.3191,103.8449,https://www.moe.gov.sg/example,verified,2026-09-23,2026-09-01,2027-08-31
```

### JSON（数组，或 `{"schools": [...]}` 包裹）
```json
[
  {
    "name": "莱佛士女子中学",
    "name_en": "Raffles Girls School",
    "country": "Singapore",
    "city": "Singapore",
    "district": "SG-SIN-NOVENA",
    "stages": ["lower-secondary", "upper-secondary"],
    "curricula": ["Singapore-Cambridge O Level"],
    "source_url": "https://www.moe.gov.sg/example",
    "verified_status": "verified",
    "verified_at": "2026-09-23",
    "effective_from": "2026-09-01",
    "effective_to": "2027-08-31"
  }
]
```

## 3. 字段说明

### 必填（缺任一行直接判 invalid）
| 字段 | 说明 |
| --- | --- |
| `name` | 学校中文名（或原始名）；系统会按是否含中文自动补齐 name_zh / name_en |
| `country` | 国家名或 id：`Singapore` / `Singapore`（新加坡）/ `SG`；`China` / `中国` / `CN` |
| `city` | 城市名或 id：`Singapore`/`新加坡市`/`SG-SIN`；`Shanghai`/`上海`/`CN-SHA`；`Beijing`/`北京`/`CN-BJS` |

### 来源与生命周期（V1.0 数据质量核心）
| 字段 | 规则 |
| --- | --- |
| `source_url` | 学校官网/教育部/权威页面的 URL。**与 supplier_evidence 至少提供一个** |
| `supplier_evidence` | 供应商提供的证明材料编号/描述（≥3 字符） |
| `verified_status` | `verified` / `draft`（其他值按 draft 处理）。**无来源时请求 verified 会被拒绝并强制降级为 draft** |
| `verified_at` | `YYYY-MM-DD`。verified 状态必须提供 |
| `effective_from` / `effective_to` | 信息有效期。**effective_to 已过的记录不会在 C 端展示**（防止过期信息当当前事实） |

### 选填（不填则该维度显示「暂无数据」）
| 字段 | 说明 |
| --- | --- |
| `district` | 区域名或 id（如 `SG-SIN-BUKIT-TIMAH`、`浦东新区`、`CN-SHA-PUDONG`）；匹配不到字典时保留原文并告警 |
| `institution_type` | International School / Bilingual School / Private School / Public School / University / College/Diploma Institution / Language School / Vocational Institution（不在字典内会告警但不阻断） |
| `stages` | 分号或竖线分隔：`primary;lower-secondary;upper-secondary`（字典见 /api/reference） |
| `curricula` | 分号分隔：`IB DP;Cambridge AS & A Level` |
| `main_language` / `additional_languages` | 如 `English` / `Chinese (Mandarin);English` |
| `tuition_min` / `tuition_max` / `currency` | 纯数字；`currency` 默认 CNY（SG 学校填 SGD）。min > max 会报错 |
| `boarding` / `scholarships` | `true`/`false`/`1`/`0`/`是`/`否` |
| `latitude` / `longitude` | 成对提供，缺一会报错。**没有可靠坐标就不要填**——系统宁可不显示距离，也不编造 |
| `nearest_station_id` | 站点 id（见 /api/reference 的 transitStations） |
| `programs` | JSON 格式可内嵌课程数组（CSV 请后续单独导入） |

字段别名兼容：`school_name`/`school` → `name`；`min_fee`/`fee_min` → `tuition_min`；`website`/`url`/`source` → `source_url`；`verified_date` → `verified_at` 等。

## 4. 预览报告怎么读

每行返回三类结论之一，且三类计数满足 `total = importable + duplicates + invalid`：
- **importable**：通过校验，导入后成为 draft 进入审核队列。
- **duplicates**：与现有学校同城市 + 同名（中英文归一化后）→ 报「疑似重复学校: <id>」，不导入。若确为不同学校，请修改名称或补充区分字段。
- **invalid**：缺必填字段、学费区间无效、经纬度不成对、有效期倒挂、无来源却请求 verified 等 → 报具体错误。

## 5. 审核流程（导入后必经）

```
导入 → draft（C端不可见）
  → submit 提交 → pending（C端不可见）
      → approve 通过（须有来源）→ verified（C端可见）
      → reject 驳回（记录原因）→ rejected
      → request-info 要求补充 → draft
verified → expire 标记过期 → expired（C端不可见）
```

- **敏感字段变更强制复审**：学费、住宿费、一次性费用、奖学金、Programs 等被修改时，已 verified 的学校自动回到 pending，C 端立即不可见，直到重新审核通过。修订历史（字段级 old → new + 时间）保留在 `/api/admin/schools/:id/revisions`。
- 审核操作入口：管理后台「数据审核」页，或 API `POST /api/admin/queue/:schoolId/action`，body `{"action": "approve|reject|request-info|expire|submit", "note": "..."}`。

## 6. 佣金相关（B端）

- 导入学校**不会**产生任何佣金字段。B端佣金字段只来自后台在 `data/store/agreements.json` 明确录入的 `is_demo: false` 真实协议。
- 平台不自动生成、不推断、不假设任何学校的佣金。未录入协议的学校在 B 端显示「暂无代理协议记录」。

## 7. 常见错误对照

| 报错 | 原因与处理 |
| --- | --- |
| `缺少必填字段: country` | 该行国家列为空 |
| `国家无法识别: xxx` | 国家名不在字典。当前支持 Singapore/China（可用中英文或 SG/CN） |
| `城市无法识别: xxx` | 城市名不在字典。当前支持 Singapore/Shanghai/Beijing |
| `学费区间无效: min(x) > max(y)` | 修正学费数字 |
| `经纬度必须成对提供` | 补齐或同时删掉 latitude/longitude |
| `verified 状态必须提供 verified_at` | 补 YYYY-MM-DD 日期，或把 verified_status 改为 draft |
| `缺少来源(source_url 或 supplier_evidence)的数据不得标记 verified，已降级为 draft` | 预期行为：先导入为 draft，补齐来源后再审核通过 |
| `疑似重复学校: SG-DEMO-001 ...` | 与现有学校同城市同名；确认为新学校请调整名称 |

## 8. 上线前检查清单
- [ ] 每条数据都有可点击的 source_url 或供应商证明
- [ ] 学费/截止日期/招生要求都有 verified_at 与有效期的 effective_from/to
- [ ] 坐标只填可靠来源的；不可靠就留空（距离会诚实显示「暂无」）
- [ ] 预览报告 0 invalid、0 意外 duplicates
- [ ] 导入后逐条审核通过，C 端搜索抽查可见
- [ ] 不导入任何未经证实的排名、录取率、佣金承诺
