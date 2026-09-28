# Growth Center 数据字典（Data Dictionary）

V1.1 增长获客中心的数据实体、字段与约束。所有实体存储在 `data/store/growth/<entity>.json`，由 `lib/growth.js` 引擎读写（存储适配层，未来可切换 Postgres 不改动引擎）。

> 通用红线：**不允许 AI 捏造事实**；任何 `value` / 院校 / 机构事实必须有 `source_url` 或已验证供应商提交；无来源的线索仅允许「草稿级」创建，不计入已核验。

## 实体清单（ENTITIES）
`leads, scoremodels, outreach, communications, opportunities, organizations, baccounts, campaigns, onboarding, activation, insurance`

---

## 1. leads（线索）
| 字段 | 类型 | 说明 | 约束 |
|------|------|------|------|
| id | string | `LEAD-` 前缀唯一 ID | 必填 |
| lead_type | string | `external`（默认） | |
| persona_type | enum | 9 类画像，未知回退 `other` | `PERSONA_TYPES` |
| organization_name | string? | 机构主体名称 | |
| contact_name / contact_title | string? | 联系人 / 职务 | |
| country / region / city | string? | 地域 | |
| website / website_domain | string? | 官网 / 派生域名（用于去重） | domain 自动派生 |
| email / phone / whatsapp / wechat | string? | 联系方式 | 用于去重 key |
| linkedin_url | string? | LinkedIn | 去重 key |
| social_accounts | string[] | 社交账号 | 去重 key |
| followers / engagement_rate / posting_frequency | number? | 受众规模/互动/频率 | KOL 画像用 |
| main_countries / education_stages / curricula / languages | array | 匹配维度 | |
| estimated_student_pool / estimated_family_pool / annual_student_volume | number? | 学生池估算 | |
| partner_school_count | number? | 合作院校数 | |
| accepts_partnership / accepts_commission / accepts_agency_agreement | bool? | 合作意向 | 评分维度 |
| source_type / source_name / source_url | string? | **来源类型/名称/URL** | 无 `source_url` 仅草稿级 |
| source_confidence | enum | `low/medium/high` | 默认 `medium` |
| captured_at / last_verified_at | ISO | 采集/核验时间 | |
| score / score_tier / score_model / score_reason | number/enum/string/array | 评分结果 | 引擎计算，禁手工捏造 |
| stage | enum | `new/contacted/qualified/opportunity/converted/rejected/do_not_contact` | |
| owner_id / last_contact_at / next_followup_at | 归属/时间 | | |
| do_not_contact / opt_out_at | bool/ISO | 免打扰 / 退订时间 | `opt_out` 自动置 |
| converted_organization_id / converted_b_account_id | string? | 转化后关联 | |
| notes | string? | 备注 | |
| evidence | LeadEvidence[] | 富集证据 | 见下 |
| merge_history | array | `{{merged_from, at, note}}` | 合并记录 |
| dedup | object | `{match, candidates}` | 运行期附加，不持久化归因 |

### LeadEvidence（证据）
`{ id: 'EV-…', field, value, source_url, captured_at, confidence: 'low|medium|high', note }`
- **value 不可由 LLM 生成**，必须来自 `source_url` 或人工录入。

---

## 2. scoremodels（评分模型）
`{ version, active: 'general', models: [ { id, name, persona, weights, max_score } ] }`
- `weights`：9 维权重（`organization_strength, audience_strength, student_pool, platform_match, cooperation_intent, online_influence, engagement, data_quality, risk`），`risk` 为负权重（opt-out/do-not-contact 扣分）。
- 评分分级：`A≥75 / B≥55 / C≥35 / D<35`。

---

## 3. outreach（触达队列）
`{ version, queue: [ OutreachItem ] }`
- OutreachItem：`{ id:'OUT-…', lead_id, channel, template, content, status:'queued', owner_id, next_action, created_at, sent_at, result }`
- **默认 `status=queued`（草稿，人工复核后发送）**；`do_not_contact` 线索无法入队。

---

## 4. communications（沟通 CRM）
`{ version, items: [ Communication ] }`
- Communication：`{ id:'COMM-…', lead_id, channel, direction, content, sent_at, reply_at, status, result, owner, next_action, next_action_at }`
- `result` ∈ `COMM_RESULTS`：`no_reply/replied/interested/not_interested/meeting_booked/wrong_contact/opt_out`；`opt_out` → 置线索 `do_not_contact`。

---

## 5. opportunities（商机，S0–S8）
`{ version, items: [ Opportunity ] }`
- Opportunity：`{ id:'OPP-…', lead_id, persona_type, owner, potential_student_volume, target_markets, interested_services, estimated_value, probability, next_action, stage, organization_id, b_account_id, history }`
- `stage` ∈ `OPP_STAGES`：`S0 Discovery / S1 Evaluated / S2 First Contact / S3 Engaged / S4 Negotiation / S5 Agreement / S6 Onboarded / S7 Activated / S8 First Revenue`。
- **S5 才创建 Organization（带 lead 归因）；S6 关联组织；Lead 绝不直接成 B 账户。**

---

## 6. organizations（组织，由商机 S5 生成）
`{ version, items: [ Organization ] }`
- Organization：`{ id:'ORG-…', source_lead_id, lead_attribution:{lead_id, source_type, source_name, source_url, captured_at}, organization_name, persona_type, status:'invited', created_at, updated_at }`
- **lead_attribution 永久保留原始线索来源。**

---

## 7. baccounts（B 端账号，由入驻完成后生成）
`{ version, items: [ BAccount ] }`
- BAccount：`{ id:'BACC-…', organization_id, lead_attribution（继承组织）, persona_type, status:'active', created_at, updated_at }`
- 仅在 **入驻 10 步全部完成** 后创建，确保「Lead → 商机 → 组织 → B 账户」严格链路。

---

## 8. campaigns（活动）
`{ version, items: [ Campaign ] }`
- Campaign：`{ id:'CAMP-…', name, persona, country, lead_filters, channel, template, start_at, end_at, owner, stats:{target_leads, contacted, delivered, opened, replied, positive_reply, meeting, onboarded, activated, first_revenue} }`

---

## 9. onboarding（入驻流程）
`{ version, items: [ Onboarding ] }`
- Onboarding：`{ id:'ONB-…', organization_id, lead_id, steps:[{key,label,status:'pending'|'done'}×10], status:'in_progress'|'completed' }`
- 步骤：`register / entity_type / profile / qualification / contact / target_country / business_scale / agreement / review / account_open`。

---

## 10. activation（激活事件）
`{ version, items: [ Activation ] }`
- Activation：`{ id:'ACT-…', b_account_id, events:{}, first_value_at, first_revenue_at }`
- 事件 ∈ `first_login, first_school_search, first_program_view, first_favorite, first_student_created, first_application, first_agreement, first_commission`；`first_application`→`first_value_at`，`first_commission`→`first_revenue_at`。

---

## 11. insurance（保险预留，**未启用**）
`{ version, feature_flag:{ insurance_enabled: false }, providers:[ { id:'insurance-reserved', provider_type:'insurance', integration_mode:'manual', integration_status:'reserved', note } ], service_products:[], integration_configs:[] }`
- 仅占位；不实现产品/核保/理赔/接入。未来通过 Provider + ServiceProduct + IntegrationConfig 扩展。

---

## 去重键（leadMatchKeys）
`domain:<host> / org:<name> / email:<addr> / phone:<digits> / li:<url> / social:<handle>`
- 任意 `email|phone|domain|org` 精确命中 → `exact_match`（409，不写入第二条）；否则若有重叠 → `probable_match`；转人工 `manual_review`。
