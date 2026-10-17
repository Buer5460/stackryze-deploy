# FULL MVP V3 — 状态机文档

**版本**：3.0.0 ｜ 实现位置：`lib/auth.js`（定义）+ `lib/applications.js`（执行）+ 各领域模块

---

## 1. 统一申请状态机 S0–S10

五端共用。每个阶段记录：`owner`、`status`、`started_at`、`completed_at`、`deadline`、`todos`、`documents`、`messages`、`audit_log_ids`。视图：Kanban / Timeline / List。

| 阶段 | 名称 | owner | 默认待办 |
| --- | --- | --- | --- |
| S0 | 意向 Lead | B | 收集联系方式；确认需求 |
| S1 | 匹配 Matching | B | 匹配学校/供应商；确认课程 |
| S2 | 申请 Application | B | 准备申请表；提交申请 |
| S3 | 材料 Documents | C | 上传成绩单；上传护照；上传语言成绩 |
| S4 | 面试/测试 Interview | S | 预约面试；完成面试 |
| S5 | 录取 Admission | S | 等待结果；接受 Offer |
| S6 | 合同 Contract | S | 确认条款；支付押金 |
| S7 | 签证 Visa | B | 准备签证材料；递交签证 |
| S8 | 行前 Pre-departure | B | 安排住宿；行前说明 |
| S9 | 入学 Enrollment | S | 确认入学；完成注册 |
| S10 | 佣金结算 Commission | ADMIN | 结算佣金 |

### 流转规则（代码强制）

```
合法正向链：S0→S1→S2→S3→S4→S5→S6→S7→S8→S9→S10
终态：S10（completed）、REJECTED、CANCELLED、WITHDRAWN
禁止：跳级（S0→S5 非法）、回退、S10 之后任何流转
前进闸：当前阶段存在未完成待办 → 400 STAGE_TODOS_INCOMPLETE（blocking 列出待办标题）
```

每次流转写 `application_timeline`（opened/completed/entered）与 `audit_logs`；进入 S10 触发 `APPLICATION_REACHED_S10` 佣金事件。

### S1 教育机构录取子状态机

```
received → documents_review → additional_documents → interview_required
→ interview_scheduled → interview_complete → under_review → admitted
→ waitlisted | rejected → confirmed → deposit_paid → enrolled | withdrawn
```

存储于 `applications.admission_status`，由教育机构供应商维护（`PUT /api/s/education/admissions/:id`）。

---

## 2. 绑定状态机（规则 7 / 12 / 13）

```
unbound（C 自主注册默认）
  └─► pending_b_request ── B reject ──► rejected_by_b（终态）
        │
        B accept（闸：接单上限；超限 400 ORDER_CAP_REACHED）
        ▼
   pending_contract ── C 签 ──► pending_b_signature ── B 签 ──► active
        │                                                    │
        └──────────── 任一方重复签署 ──► 400 ─────────────────┘
   active ── B 会员超期 ──► superseded_by_platform（C → platform_service）
   active ── C 解绑 ──► unbound（写 unbind_reason）
```

**首绑保护**：每个新绑定记录 `first_binding_protected_until = 生效 + 12 个月`（后台可配）。
**换绑**（保护期内）：`is_rebinding=true`，需依次满足

```
original_b_consent ──► new_b_consent ──► platform_review(approve)
```

任一步缺失即拒绝；通过后生成新合同、双签、激活，并审计 `binding:commission_ownership_transfer`。

---

## 3. 会员状态机（规则 13）

```
active ── expires_at 到期 ──► expired + grace_until = 到期 + 30 天
   │                              │
   │ 续费（新建会员，旧会员→superseded）
   ▼                              ├─ 宽限期内：membershipValid()=true（reason=grace）
superseded                        └─ 宽限期外：valid=false（reason=expired）
                                     └─ B 到期处理：名下 active 绑定全部
                                        → superseded_by_platform，C → platform_service
                                        （审计 binding:membership_expiry_transfer）
```

提醒节点：到期前 **60 / 30 / 7 / 1** 天（`membership_expiry_reminder_days`，后台可配）。
`membershipExpiryInfo()` 输出 `days_to_expiry` 与 `due_reminders`。

---

## 4. 合同状态机（规则 7）

```
draft ──► pending_c_signature（C 先签）
      ──► pending_b_signature（B 先签时）
      ──► active（双签齐，记 effective_at）
      ──► terminated
```

同一方重复签署 400；签署走 `providers.signature` 适配器（默认 sandbox，`provider_mode` 透出）。版本：新版本生成时旧版本 → `superseded`，`agreements.body` 镜像最新版。

---

## 5. 佣金 / 结算状态机（规则 9）

```
佣金台账：projected → confirmed → receivable → received → payable → paid
                         ↘ 任意状态 ──► clawed_back（退款触发）
结算单：  projected → confirmed → receivable → received → payable → paid
                         ↘ 任意状态 ──► clawed_back
```

结算单只允许**单步前进**（`toIdx !== idx+1` 即 400），clawback 例外；结算状态同步镜像到关联台账。

---

## 6. 支付状态机（规则 11，AETHEL X）

```
created ──► requires_action ──► processing ──► succeeded ──► refunded（退款）
                                       └──► failed / cancelled
Sandbox：confirm 即 succeeded 并签发 receipt（sandbox=true, reference=NXS-…）
Live：confirm 返回 pending_external，绝不伪造成功
```

触发事件：`PAYMENT_SUCCEEDED`（申请费）→ 佣金计算；退款 → 关联佣金 `clawed_back`。

---

## 7. 六类供应商订单状态机

| 类型 | 状态链 | 存储 |
| --- | --- | --- |
| S2 体检 | requested → scheduled → completed / cancelled（completed 记 report_file + meets_study_requirement；**不存诊断**） | `medical_orders` |
| S3 认证 | requested → documents_review → additional_documents → processing → completed / cancelled | `certification_orders` |
| S4 签证 | requested → materials → appointment → submitted → additional_documents → result(approved/rejected/pending/additional_docs) / cancelled（result 同步写 visa_case） | `visa_orders` |
| S5 住宿 | reserved → checked_in → checked_out / renewed / cancelled（床位库存随状态自动增减，可用床位恒 ≥ 0） | `bookings` |
| S6 金融 | **默认关闭**（FINANCE_DISABLED），无状态机 | — |
| S1 教育 | 走统一 S0–S10 + 录取子状态机 | `applications` |

---

## 8. 广告订单状态机（广告中心）

```
cart ── Sandbox 付款 ──► paid（预留库存 reserved+1）
     ──► creative_uploaded（素材上传，强制"广告/推广"标注）
     ──► approved | rejected（仅平台可审）
     ──► scheduled（排期投放，产生曝光/点击/转化事件）
续费：renewals < max_renewals（默认 6，后台可配），超限 409
```

广告预算不进入自然排名（`ad_budget_affects_ranking` 恒 false，报表声明该规则）。

---

## 9. 核验状态机（Demo / Verified，规则 20）

```
draft → pending → verified | rejected
verified ── effective_to 过期或复审 ──► expired
```

`approve` 的前置条件：`source_url` 或 `supplier_evidence` 至少存在一个，否则 400"缺少来源"。AI 禁止补：学费 / 录取率 / 排名 / 佣金 / 贷款利率 / 床位库存 / 签证成功率。
