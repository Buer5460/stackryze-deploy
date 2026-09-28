# 新加坡真实学校数据导入指南（V1.0.1）

本文档面向运营 / BD，说明如何把新加坡真实学校安全导入 GlobalStudy。
**核心原则：每条事实都要有官方来源，AI 不编造学校数据。**

---

## 一、从哪里获取来源（可信来源优先级）

| 优先级 | 来源 | 说明 |
| --- | --- | --- |
| ★★★ | 学校官网页面 | 学校自己的官网「About / Admissions / Fees」页 |
| ★★★ | 新加坡教育部 MOE | https://www.moe.gov.sg |
| ★★★ | 私立教育理事会 CPE | https://www.singaporeedu.gov.sg（EduTrust 登记） |
| ★★ | 官方学校目录 / 年鉴 | 政府或学校协会发布的官方目录 |
| ★★ | 已验证供应商提交 | 书面证明（supplier_evidence） |
| ✕ | 搜索引擎摘要 / 维基 / 论坛 | 仅用于「发现来源」，不能直接作为事实 |
| ✕ | AI 生成内容 | 不得作为事实来源 |

> 搜索引擎、AI 只能用于**发现来源链接**与结构化整理，不能作为事实本身。

---

## 二、字段清单（每所真实学校必填/选填）

**必填（缺任一项 → 该行无效，不会导入）：**
- `name`（学校名称，含中文用 `name_zh`，英文用 `name_en`）
- `country`（填 `Singapore` 或 `SG`）
- `city`（填 `Singapore` 或 `SG-SIN`）
- `source_url`（官方来源链接，HTTPS）

**审核通过前还需要：**
- `verified_at`（核验日期 YYYY-MM-DD）
- `effective_from` / `effective_to`（信息有效期）

**选填（尽量完整，提升核验价值）：**
- `institution_id`（自定义稳定 ID，如 `SG-NUS`；不填系统自动分配）
- `address`、`website`、`district`
- `institution_type`、`stages[]`、`curricula[]`、`main_language`、`additional_languages[]`
- `tuition_min` / `tuition_max` / `currency`
- `boarding`、`scholarships`
- `nearest_station_id`、`latitude`、`longitude`

> 经纬度、学生规模、排名、录取率、佣金等**拿不到就留空**，绝不填假数据。

---

## 三、用模板（推荐）

1. 后台「真实数据导入」页 → 点「填入示例模板」，自动载入 `templates/singapore-schools-import-example.csv` 的 9 条演示行（**仅示例，导入前请替换为真实数据**）。
2. 或下载 `templates/singapore-schools-import.csv`（仅表头）自行填写。
3. 字段顺序不限；列名支持别名，例如：
   - `school` / `school_name` → `name`
   - `chinese_name` → `name_zh`
   - `english_name` → `name_en`
   - `street_address` → `address`
   - `official_website` → `website`
   - `status` → `verified_status`
   - 详见 `lib/importer.js` 的别名表。

---

## 四、导入流程（两步确认）

1. **① 预览校验**：上传文件或粘贴 CSV/JSON → 系统返回：
   - 字段映射（每列对应到哪个标准字段，未识别列会被忽略）
   - 可导入 / 无效 / 疑似重复 计数
   - 逐行错误与警告（如「国家无法识别」「缺少来源」「疑似重复学校」）
2. **② 确认导入**：仅把**可导入**的行写入 `draft` 审核队列；无效行与重复行被跳过。
3. 到「审核队列」逐条：提交 → 通过 / 驳回 / 要求补资料。
   - **没有有效来源的记录无法通过审核（400）**。
   - 学费等敏感字段被修改会自动打回 `pending` 重新审核。

---

## 五、复核周期（新鲜度）

后台「复核周期配置」可调整（单位：月，默认）：
- 学费 `tuition` = 6
- 申请截止 `deadlines` = 4
- 奖学金 `scholarships` = 4
- 地址 / 基础资料 `basics` = 12

周期到期后在 C 端标记「待复核 / 已过期」，过期记录不再作为当前事实展示。

---

## 六、常见错误与处理

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 「国家无法识别」 | country 填了非 SG/CN 等字典值 | 用 `Singapore` 或 `SG` |
| 「缺少来源」 | 没有 source_url | 补官方链接，否则只能 draft |
| 「疑似重复学校」 | 同名同城市已存在 | 核对是否同一所，合并或改 ID |
| 「verified_status 降级为 draft」 | 标了 verified 但无来源 | 正常保护，先补来源再审核 |
| 0 行 | 仅上传了表头模板 | 填入数据再预览 |

---

## 七、禁止事项（红线）

- 不得用 AI 生成/补全学校事实（联系方式、学生量、资质、合作意愿等）。
- 拿不到的字段填 `null`，不要估算。
- 演示数据（`is_demo=true`，无 source_url）与真实数据严格分开，互不混入。
