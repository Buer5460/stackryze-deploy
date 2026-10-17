# FULL MVP V3 — 数据字典

**版本**：3.0.0 ｜ 命名规范：**snake_case**（与 V0.5 规格一致）

存储方式：单表 KV（PostgreSQL）或单 JSON 文件，按 `collection` 分集合。每个记录都有 `id`（带类型前缀）与 `_seq`（单调插入序号，用于稳定排序）。审计/时间字段统一 `created_at` / `updated_at`（ISO 8601 UTC）。

---

## 1. 身份与访问

### users
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | string `USR-*` | |
| email / phone | string/null | 至少其一 |
| password | string/null | `sha256:<hash>`（仅真实注册） |
| display_name | string | |
| audience | enum | `ADMIN` / `B` / `C` / `S` / `DBC`（由 role 推导） |
| role | enum | 19 个角色之一，见 RBAC 文档 |
| organization_id | string/null | B/S/DBC 归属 |
| language | enum | `zh` / `en` |
| status | enum | `active` / `disabled` |
| is_demo | boolean | 演示账号 |
| demo_token | string/null | 一键体验 Token |

### sessions
`id` `user_id` `token`（`tok-*`）`created_at` `last_seen_at` `expires_at`（7 天）`ip` `user_agent` `is_demo`

### organizations
`id(ORG-*)` `kind(B|S|DBC|PLATFORM)` `name` `name_en` `legal_name` `country` `city` `contact_name/email/phone` `website`
KYC/KYB/AML：`kyc_status` `kyb_status` `aml_status`（`pending|approved|rejected`）`kyc_provider('sandbox')` `financial_docs_complete` `verified` `verified_at`
治理：`status(active|frozen|suspended)` `frozen_reason` `is_demo`

### memberships
`id(MBR-*)` `organization_id` `level(FREE|LEVEL_1|LEVEL_2)` `status(active|grace|expired|cancelled|superseded)` `starts_at` `expires_at` `grace_until` `auto_renew` `price` `currency` `source`

### b_profiles
`id(BPF-*)` `organization_id` `level` `service_countries[]` `service_courses[]` `service_stages[]` `service_types[]` `languages[]`
接单：`daily_order_cap` `monthly_order_cap`
准入（规则 4）：`accepts_platform_recommendation` `recommendation_paused` `verified` `contract_valid` `unresolved_serious_disputes` `operational_status(normal|limited|paused)` `status_a` `status_b`
画像：`avg_response_minutes` `rating_avg` `rating_count` `active_c_students` `commission_agreements_count`

### c_profiles
`id(CPF-*)` `user_id` `name` `name_en` `email` `phone` `nationality` `education_stage` `target_countries[]` `target_courses[]` `guardian_name` `guardian_relation` `language`
绑定：`binding_state(unbound|pending_*|active|protected|grace|platform_service)` `bound_b_organization_id` `bound_at`
来源：`source(self_registration|invite|share|ad|referral)` `invited_by`

### suppliers / supplier_profiles
`suppliers`：`id(SUP-*)` `organization_id` `type(EDUCATION|MEDICAL|CERTIFICATION|VISA|ACCOMMODATION|FINANCE)` `name` `name_en` `verification(draft|pending|verified|rejected|expired)` `verified_at/by` `is_demo` `source_url` `supplier_evidence` `effective_from/to` `status` `public_visible` `accepts_b_orders`
`supplier_profiles`：`id(SPF-*)` `supplier_id` `description(_en)` `languages[]` `service_countries[]` `service_cities[]` **私有联系渠道** `contact_phone/email/whatsapp`（永不透出给 C）`media[]` `qualifications[]` `extensions{}`（按类型扩展）

### dbc_profiles
`id(DBP-*)` `organization_id` `licence_number` `licence_status` `agreement_files[]` `state_a_only(true)`

---

## 2. 推荐与绑定

### recommendations
`id(REC-*)` `requirement_id` `tier(LEVEL_2|LEVEL_1|null)` `mode(recommended|browse_only|none)`
`candidates[]`：`rank` `b_organization_id` `b_profile_id` `level` `score` `score_parts{}` `explain[]` `languages[]` `service_countries[]` `avg_response_minutes` `rating_*`（**无佣金字段**）
`excluded[]`：`b_organization_id` `level` `failures[]`
`status(pending|accepted|exhausted)` `created_at`

### recommendation_rotations
`id(ROT-*)` `recommendation_id` `b_organization_id` `requirement_id` `tier` `created_at`（公平轮换计数依据）

### bindings
`id(BND-*)` `c_profile_id` `b_organization_id` `b_profile_id` `recommendation_id`
`status(pending_b_request|pending_contract|pending_c_signature|pending_b_signature|active|rejected_by_b|unbound|superseded_by_platform)`
`initiated_by` `contract_id` `requested_at` `responded_at` `contract_effective_at`
首绑保护：`first_binding_protected_until` `protection_months`
换绑：`is_rebinding` `previous_b_organization_id` `rebinding{original_b_consent,new_b_consent,platform_review}`

### binding_histories
`id(BNDH-*)` `binding_id` `event` `note` `at`

---

## 3. 合同与佣金

### agreements
`id(AGR-*)` `kind(B_C|B_S|DBC_B|DBC_S|S_PLATFORM)` `title` `b_organization_id` `c_profile_id` `supplier_id` `dbc_organization_id` `binding_id`
`state(A|B)`（状态 A = DBC 链路；状态 B = B↔S 直连）`product_id` `status(draft|pending_c_signature|pending_b_signature|active|terminated)` `currency` `current_version_id` `body`（镜像最新版本）`commission_rule_ids[]` `is_demo` `effective_at`

### agreement_versions
`id(AGV-*)` `agreement_id` `version` `body` `effective_from/to` `status(current|superseded)`

### signatures
`id(SIG-*)` `agreement_id` `version_id` `signer(C|B)` `signed_by_user_id` `signed_at` `provider` `provider_mode` `evidence_ref`

### contract_evidence
`id(CEV-*)` `agreement_id` `kind(document|screenshot|hash|timestamp)` `source_url` `content_hash` `note` `uploaded_by`

### commission_rules
`id(CMR-*)` `supplier_id` `product_id` `b_organization_id` `agreement_id` `agreement_version_id`
`mode(PERCENTAGE|FIXED_PER_STUDENT|FIXED_PER_BOOKING|TIERED|BONUS|RENEWAL|MULTI_PERIOD)` `value` `currency` `tiers[]` `bonus_value` `renewal_value` `periods[]`
`trigger_event` `settlement_cycle_days` `status` `is_demo` `effective_from/to` `source_document`

### commission_ledger
`id(CML-*)` `fee_breakdown_id` `commission_rule_id` `b_organization_id` `supplier_id` `product_id` `application_id` `payment_intent_id`
`trigger_event` `amount`（= 净佣金归 B）`currency`
`status(projected|confirmed|receivable|received|payable|paid|clawed_back)`

### fee_breakdowns
`id(FBD-*)` + 计算快照：`base_amount` `committed` `aethel_x_orchestration_fee` `payment_gateway_fee` `net_to_b` `platform_share_of_net(恒0)` `mode` `trigger_event`

### settlements
`id(STL-*)` `b_organization_id` `supplier_id` `commission_ledger_ids[]` `total_amount` `currency` `status`（同台账 7 态）`cycle_days` `due_date`

---

## 4. 课程目录 / 六类服务

沿用 V1：`institutions` `campuses` `programs` `scholarships`（见 `DATA_DICTIONARY.md` V1 部分）。

### 住宿（S5）
`accommodations` `id(ACC-*)` `supplier_id` `name` `latitude` `longitude` `verified` `is_demo`
`rooms` `id(ROM-*)` `supplier_id` `accommodation_id` `name` `room_type(single|double|triple|shared|homestay)` **`beds_total` `beds_occupied`**（不变式：`beds_available = beds_total − beds_occupied ≥ 0`）`price` `currency` `available_from/to`
`bookings` `id(BKG-*)` `supplier_id` `room_id` `c_profile_id` `application_id` `check_in/out` `status(reserved|checked_in|checked_out|renewed|cancelled)` `price`
`guardian_services` `id(GRD-*)`

### 体检（S2）
`medical_services` `medical_orders` `id(MDO-*)` `supplier_id` `application_id` `c_profile_id` `service_id` `status(requested|scheduled|completed|cancelled)` `appointment_at` `completed_at` `report_file` `meets_study_requirement`
**不保存医疗诊断。**

### 认证（S3）
`certification_orders` `id(CRO-*)` `certification_type(degree|transcript|notarisation|translation|other)` `status(requested|documents_review|additional_documents|processing|completed|cancelled)` `report_file` `additional_documents_required`

### 签证（S4）
`visa_services` `visa_orders` `id(VOR-*)` `visa_type` `target_country` `status(requested|materials|appointment|submitted|additional_documents|result|cancelled)` `appointment_at` `submitted_at` `result(approved|rejected|pending|additional_docs)`
`visa_cases` `id(VCS-*)` `application_id` `status` `steps[]`；`visa_results` `id(VRS-*)` `outcome` `note`

### 金融（S6，默认关闭）
`finance_products` `finance_referrals` — 仅结构预留；`extensions.credit_scoring_enabled / auto_approval_enabled / disbursement_enabled` 恒 `false`。

---

## 5. 学生材料

### family_documents
`id(FMD-*)` `c_profile_id` `application_id`
`type(passport|transcript|degree|language_score|offer|visa|medical|certification|other)`
`file_name` `file_url` `mime_type` `size_bytes`
`ocr{provider:'sandbox', mode:'sandbox', classified_as, extracted_fields, sandbox:true, run_at}`（Mock，明确标注）
`status(uploaded|b_confirmed|s_confirmed|rejected)` `version` `b_confirmed_at/by` `s_confirmed_at/by` `note`

### document_versions
`id(DMV-*)` `document_id` `version` `file_name` `file_url` `uploaded_by`

### document_authorizations
`id(DAU-*)` `document_id` `granted_to_type(S|DBC)` `granted_to_id` `scope(read)` `granted_by` `granted_at` `expires_at` `revoked_at` `status(active|revoked)`
**学生敏感资料必须授权后才能看。**

---

## 6. 申请状态机

### applications
`id(APP-*)` `c_profile_id` `b_organization_id` `supplier_id` `product_id` `institution_id` `program_id` `title` `current_stage(S0–S10|REJECTED|CANCELLED)` `status` `admission_status`（S1 教育录取状态机）`priority` `closed_at`

### application_stages
`id(APS-*)` `application_id` `code(S0–S10)` `key` `owner(ADMIN|B|C|S)` `status(pending|in_progress|completed)` `started_at` `completed_at` `deadline` `todos[]{key,label_zh,label_en,status,owner}` `documents[]` `messages[]` `audit_log_ids[]`

### application_timeline
`id(ATL-*)` `application_id` `stage` `event(opened|completed|entered)` `at` `by` `note`

### application_todos
`id(ATD-*)` `application_id` `stage` `title(_en)` `owner` `due_at` `status(pending|done)` `completed_at`

---

## 7. 支付编排（AETHEL X）

### payment_intents
`id(PIN-*)` `kind(application_fee|registration_fee|service_fee|ad_order|membership|commission_settlement)`
`amount` `currency` `payer_type(C|B|S|DBC)` `payer_id` `payee_type/id` `related{application_id, order_id, ad_order_id, settlement_id}`
`status(created|requires_action|processing|succeeded|failed|cancelled|refunded)` `provider_id` `route_id` `receipt_id` `refund_ids[]` `description`
多币种：`reference_rate` `rate_timestamp`（无 FX 交易）`sandbox`

### payment_routes / payment_providers / payment_receipts / refunds / commission_triggers
`PRT-*` `PPR-*`（adapter: nexuspay|stripe|bank_transfer|manual|other，mode: sandbox|live）`PRC-*`（reference, method, sandbox, paid_at）`RFD-*`（amount, reason, status）`CMT-*`（trigger_event, fired_at）

---

## 8. 互动

`reviews RVW-*`（supplier_id, c_profile_id, application_id, rating 1–5, content, status）
`messages MSG-*`（thread_id, from_type/id, to_type/id, body, read_at）
`notifications NTF-*` `daily_briefs DBF-*`（按端实时生成，含今日待办/临近截止/材料缺失/状态更新）
`disputes DSP-*`（b_organization_id, supplier_id, application_id, subject, description, status, resolution）
`dispute_evidence DSE-*`

---

## 9. 广告中心

`ad_products ADP-*` `ad_inventory ADI-*`（slot_type: search_ranking_sponsored|banner|recommended_slot|splash，total/reserved，monthly_price 取自配置）
`ad_orders ADO-*`（inventory_id, advertiser_type/id, amount, currency, renewals ≤ max_renewals，status: cart→paid→creative_uploaded→approved→scheduled|rejected）
`ad_creatives ADC-*` `ad_schedules ADS-*` `ad_reports ADR-*`（event: impression|click|conversion）
展示侧强制标注 **"广告 / 推广"**；广告预算不影响自然排名。

---

## 10. 治理

### audit_logs
`id(LOG-*)` `at` `actor_id/role/name` `audience` `action` `entity` `entity_id` `from` `to` `note` `request_id` `ip` `denied` `evidence_id`
`action` 命名：`<域>:<动作>`（如 `binding:accept`、`application:transition`、`payment:refund`、`commission:compute`）。

### source_evidence / system_config
`SRC-*`；`system_config` 单条 `id=SYSTEM`，`values`（全部默认策略）+ `history[]`（每次变更含 path/from/to/by）。

---

## 11. AI 补数禁令

`system_config.ai_may_not_invent` = `["tuition","admission_rate","ranking","commission","loan_rate","bed_inventory","visa_success_rate"]`。
真实数据必须带 `source_url` 或 `supplier_evidence` 才能进入 Verified 状态（代码强制）。
