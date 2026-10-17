# FULL MVP V3 — API 文档

**版本**：3.0.0 ｜ 基地址：`https://global-study-mobile-mvp.onrender.com`

统一响应：`{ "ok": true, "data": ..., "meta"?: ... }` 或 `{ "ok": false, "error": "..." }`。
认证：`Authorization: Bearer <token>`（注册/登录/Demo-login 获得；7 天有效）。

---

## 1. 公开（无需登录）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 服务状态、版本、持久化后端（如实上报）、集合计数、客户端清单、功能开关、Sandbox 配置 |
| GET | `/api/meta` | 品牌、客户端清单、数据政策、支付适配器目录 |
| GET | `/api/reference` | S0–S10 阶段、供应商类型、B 等级、角色权限目录、材料类型、支付类型、佣金模式 |
| GET | `/api/public/suppliers?type=&q=` | 公开供应商列表（无佣金、无私有联系方式） |
| GET | `/api/public/suppliers/:id` | 公开供应商详情 |
| GET | `/api/public/schools` | 学校搜索（沿用 V1 引擎：q/country/stage/curriculum/fee 等） |
| GET | `/api/public/accommodation?school_id=` | 学校附近住宿，按直线距离排序（不虚构通勤时间） |

---

## 2. 认证

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/register` | `{email|phone, password, display_name, role}`；C 角色自动建待绑定档案 |
| POST | `/api/auth/login` | `{email, password}` |
| GET | `/api/auth/demo-accounts` | Demo 一键体验账号清单（含 token 与落地路由） |
| POST | `/api/auth/demo-login` | `{token}` → `{token, user}` |
| POST | `/api/auth/logout` | 注销会话 |
| GET | `/api/auth/me` | 当前用户 + C 档案/能力（C）/ 机构与会员（B） |

---

## 3. C 端 `/api/c`

**绑定前可用**（规则 2）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/capabilities` | 当前绑定状态下的能力矩阵 |
| PATCH | `/profile` | 更新档案 |
| POST | `/requirements` | 提交需求 → 同步返回推荐（Level 2 优先，3–5 家） |
| GET | `/recommendations` | 历史推荐 |
| POST | `/bindings` | `{b_organization_id}` 发起绑定 |
| GET | `/bindings` / `/bindings/:id` | 绑定列表/详情 |
| POST | `/bindings/:id/sign` | C 电子签 |
| GET | `/suppliers` / `/suppliers/:id` | 浏览公开供应商（无私人渠道） |

**绑定闸之后**（未绑定 403 `C_UNBOUND`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/me` | 档案 + 绑定 + 合同 + 能力 |
| GET | `/my-b` | 我的服务机构 / 服务范围 / 合同（**无佣金字段**） |
| POST | `/applications` | 建申请（S0，铺开 11 阶段） |
| GET | `/applications` / `/applications/:id` | 申请列表/详情（含 stages/timeline/documents/todos） |
| GET | `/applications/:id/timeline` | 时间线视图 |
| POST | `/applications/:id/documents` | 上传材料（OCR=Sandbox Mock） |
| GET | `/documents` | OCR 家庭材料库（一次上传多申请复用） |
| POST | `/documents/:id/authorize` | `{grantee_type, grantee_id, scope}` 授权读取 |
| GET | `/applications/:id/visa` | 签证中心（只读步骤/进度/待办/结果） |
| POST | `/payments` | `{kind, amount, currency, application_id, reference_rate?}` 建 AETHEL X Intent |
| POST | `/payments/:id/confirm` | Sandbox 确认 → 凭证（响应无佣金字段） |
| POST | `/payments/:id/refund` | 退款（自动扣回关联佣金） |
| GET | `/payments` | 支付记录（金额/状态/凭证/退款状态） |
| POST | `/reviews` | 申请成功后评价 S |
| GET/POST | `/messages` | 站内信（真实可用） |
| GET | `/todos` / `/brief` | 待办 / 每日简报（今日待办/临近截止/材料缺失/状态更新） |
| POST | `/unbind` | 解绑 |
| GET | `/rebinding/check` · POST `/rebinding` | 保护期检查 / 发起换绑 |

---

## 4. B 端 `/api/b`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/me` | 机构 + 档案 + 会员（含到期提醒）+ 接单容量 |
| PATCH | `/profile` | 更新机构/档案（含服务国家、接单上限等准入字段） |
| POST | `/recommendation-switch` | 接受/暂停平台推荐（规则 4 开关） |
| GET | `/admission` | 自检 14 项准入与失败原因 |
| GET | `/binding-requests` | 待处理绑定申请 |
| POST | `/binding-requests/:id/respond` | `{response: accept|reject}`；accept 生成 B-C 合同 |
| POST | `/binding-requests/:id/sign` | B 电子签 |
| POST | `/binding-requests/:id/consent` | 换绑同意（`{party: original_b|new_b}`） |
| GET | `/clients` | C 客户池（active/pending/historical） |
| GET | `/clients/:cProfileId` | 客户 360：档案 + 申请 + 家庭材料库 |
| GET | `/suppliers` / `/suppliers/:id` | S 资源中心（**B 视图含合作条件/协议状态/佣金规则**） |
| GET/POST | `/applications` | 申请列表 / 代客户建委托申请 |
| POST | `/applications/:id/transition` | `{target, force?}` 推进阶段 |
| GET | `/kanban` | S0–S10 看板 |
| POST | `/documents/:id/confirm` | B 确认材料 |
| POST | `/applications/:id/todos` · POST `/todos/:id/complete` · GET `/todos` | 待办 |
| PUT | `/applications/:id/visa` | 录入签证状态/结果（Approved/Rejected/Pending/Additional Docs） |
| GET/POST | `/payments` · POST `/payments/:id/confirm` | 申请费/注册费支付与确认 |
| GET | `/contracts` / `/contracts/:id` | 合同中心（B-C/B-S/DBC-B） |
| GET | `/commission` | 佣金台账 + 七态汇总（预计/确认/应收/已收/应付/已付/扣回） |
| GET | `/settlements` · POST `/settlements/:id/advance` | 结算中心 |
| GET | `/performance` | 招生绩效 + 目标预警（差 5/3/1 提醒） |
| GET | `/health` | 健康度评分（因子可解释） |
| POST | `/assistant` | 智能助手：查询/解释/匹配/材料缺失/合同摘要/待办摘要（**禁止改资金/签合同/递签**，响应带 guard 声明） |
| GET/POST | `/team` | 团队 RBAC（Owner/Counsellor/Document/Finance/Viewer） |
| GET/POST | `/disputes` · POST `/disputes/:id/evidence` | 争议仲裁 |
| GET/POST | `/messages` · GET `/brief` · GET `/recommendations` | 消息 / 简报 / 收到的推荐 |

---

## 5. S 端 `/api/s/:type`（type = education / medical / certification / visa / accommodation / finance）

全部类型共享：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/me` | 供应商 + 档案 + 类型 + finance_enabled |
| PATCH | `/profile` | 更新档案 |
| GET | `/applications` / `/kanban` | 路由到本供应商的申请与看板 |
| POST | `/applications/:id/transition` | 推进阶段 |
| GET | `/documents` · POST `/documents/:id/confirm` | 材料确认（须在 B 之后） |
| GET | `/family-documents` | 家庭库（`authorized` + `pending_authorization` 两组） |
| GET | `/visa` | 只看授权学生签证 |
| GET | `/commission` · POST `/commission/rules` | 佣金规则（demo 明确标注）/ 新建规则 |
| GET | `/settlements` / `/agreements` | 结算 / 协议 |
| GET/POST | `/messages` · GET `/todos` / `/brief` / `/audit` | 消息 / 待办 / 简报 / 审计 |

类型专属：

| 类型 | 专属端点 |
| --- | --- |
| education | `GET /admissions` · `PUT /admissions/:applicationId`（14 态录取状态机） |
| medical | `GET/POST /orders` · `POST /orders/:id/status`（requested→scheduled→completed，只存预约/状态/报告/是否满足留学要求） |
| certification | `GET/POST /orders` · `POST /orders/:id/status`（含补件） |
| visa | `GET/POST /orders` · `POST /orders/:id/status`（递交/补件/结果，结果同步 visa_case） |
| accommodation | `GET/POST /rooms`（床位不变式）· `GET/POST /bookings` · `POST /bookings/:id/status`（入住/退宿自动增减库存）· `GET /guardian-services` |
| finance | **全部请求 403 `FINANCE_DISABLED`**（功能默认关闭） |

---

## 6. DBC 端 `/api/dbc`（仅状态 A）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/me` | DBC 档案（`state_a_only: true`） |
| GET | `/suppliers` | 仅状态 A 供应商 |
| GET/POST | `/agreements` | 状态 A DBC-S 协议（响应声明状态 B 不可见） |
| GET | `/bs` | DBC-B 合作 |
| GET | `/applications` / `/students` / `/visa` | 状态 A 申请 / 学生 / 签证 |
| GET | `/settlements` | 状态 A 结算 |
| GET/POST | `/messages` · GET `/todos` / `/brief` | 消息 / 待办 / 简报 |

---

## 7. 广告中心 `/api/ads`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/products` | 广告位类型 + 可配置演示默认值（800 充值 / 100 月费 / 6 次续费） |
| GET | `/inventory` | 可用库存 |
| POST | `/orders` | 选位下单（cart） |
| POST | `/orders/:id/pay` | AETHEL X Sandbox 付款 → 预留库存 |
| POST | `/orders/:id/creative` | 上传素材（强制"广告/推广"标注） |
| POST | `/orders/:id/review` | 平台审核（approve/reject；供应商 403） |
| POST | `/orders/:id/schedule` | 排期投放 |
| POST | `/orders/:id/renew` | 续费（≤ max_renewals） |
| POST | `/events` | 记录 impression / click / conversion |
| GET | `/orders/:id/report` | 曝光/点击/CTR/转化/CVR/ROI + 排名不影响声明 |
| GET | `/my-orders` | 我的订单 |

---

## 8. 平台管理 `/api/admin`（必须登录，未登录 401）

| 域 | 端点 |
| --- | --- |
| 总览 | `GET /dashboard`（计数、阶段分布、支付、持久化、开关） |
| 用户 | `GET/POST /users` · `PATCH /users/:id`（五端统一，audience/role 过滤） |
| 审核 | `GET /verifications` · `POST /verifications/organizations/:id`（approve/reject/freeze/unfreeze）· `POST /verifications/suppliers/:id`（无来源拒通过） |
| B 管理 | `GET /bs` · `POST /bs/:id/membership` · `POST /bs/:id/expire`（到期 → C 转平台） |
| C/S/DBC | `GET /cs` · `GET /ss` · `GET /dbcs` |
| 推荐 | `GET /recommendation/pool` · `GET/PUT /config/recommendation-weights` · `GET /recommendation/logs` |
| 绑定 | `GET /bindings` · `POST /bindings/:id/rebinding-review` |
| 合同 | `GET /contracts` · `POST /contracts`（可记录含状态 B 的任意协议；平台仅记录） |
| 佣金 | `GET/POST /commission/rules` · `GET /commission/ledger` · `PATCH /commission/ledger/:id` |
| 支付 | `GET /payments` · `GET /payments/providers` · `POST /payments` |
| 结算 | `GET/POST /settlements` · `POST /settlements/:id/advance` |
| 申请 | `GET /applications` · `GET /kanban` · `GET /todos` · `POST /todos/:id/complete` · `GET /documents` · `GET /visa` |
| 互动 | `GET /reviews` · `GET /disputes` · `POST /disputes/:id/resolve` · `GET /messages` · `GET /brief` |
| 广告 | `GET /ads/orders` · `GET /ads/reports` |
| 审计 | `GET /audit?audience=&action=&entity=&limit=` |
| 配置 | `GET /config` · `PUT /config` · `POST /config/reset` |

---

## 9. 错误码约定

| HTTP | 场景 |
| --- | --- |
| 400 | 参数缺失/非法、非法状态流转（`STAGE_TODOS_INCOMPLETE` 带 blocking）、超接单上限（`ORDER_CAP_REACHED`） |
| 401 | 未登录（全部受保护路由） |
| 403 | 跨端访问、未绑定（`C_UNBOUND`）、功能关闭（`FINANCE_DISABLED`）、无权确认材料、供应商自审广告 |
| 404 | 资源不存在；已移除的 V1 路由（`/api/b2b/*`、`/api/growth/*`） |
| 409 | 邮箱已注册、重复绑定、广告位无库存、续费超限 |
