# FULL MVP V3 — 实施报告

**产品**：AETHEL EDU 安世达教育 / GlobalStudy — 全球学校、课程与教育服务协作平台
**版本**：FULL MVP V3（`3.0.0`）
**分支**：`workbuddy/aethel-full-mvp-v3`
**基准分支**：`global-study-mvp`（未修改 `main`）
**日期**：2026-10-17

---

## 1. 本轮定位

不再做零散页面，也不再只做原型。本轮在 V1.1 公网 MVP 之上，一次性完成**可真实操作完整业务流程、可公网访问、可直接演示**的 FULL MVP：

- 五大角色共用**一个数据模型、一个状态体系、一个合同体系、一个佣金体系、一个支付编排体系、一个审计体系**。
- 未为不同端复制多套互不兼容系统。
- 视觉体系延续既有客户认可的苹果风格卡片式 H5（"功能增加，视觉延续"）。

---

## 2. 交付内容

### 2.1 统一底座（`lib/`）

| 模块 | 职责 |
| --- | --- |
| `lib/db.js` | 持久化层。三档后端自动选择：PostgreSQL（`DATABASE_URL` + `pg`）→ JSON 文件（默认，跨重启持久）→ 内存（测试）。`aethel_kv(collection, id, doc jsonb)` 单表 KV 设计，新增实体无需迁移文件。单调 `_seq` 保证同毫秒插入顺序稳定。 |
| `lib/util.js` | ID 生成（带类型前缀）、时间、金额、haversine 距离、可种子化伪随机（用于公平轮换的确定性抖动）。 |
| `lib/auth.js` | 19 个角色的 RBAC 目录 + 权限矩阵 + 会话/Demo 登录 + 守卫工厂。 |
| `lib/config.js` | 全部策略后台可配置：推荐权重、首绑保护、宽限期、到期提醒、佣金费率、功能开关、Provider 适配器、品牌信息。 |
| `lib/audit.js` | 全量审计：actor、before/after、请求 ID、IP、denied 标记、密钥脱敏。 |
| `lib/org.js` | Organization / Membership / BProfile。会员有效性与 Rule 13 宽限期逻辑。 |
| `lib/binding.js` | C 档案、需求提交、C↔B 绑定状态机、双签激活、席位开通、首绑保护、换绑、解绑、会员到期转移。 |
| `lib/recommendation.js` | 规则 3/4/5/6：Level 2 → Level 1 → Browse Only 分级；14 项硬准入；六维加权评分；公平轮换与反霸榜；接单上限；自动切换。 |
| `lib/contracts.js` | 合同体系（5 类协议）、版本管理、双电子签、证据挂载；佣金规则 7 种模式；佣金计算（净佣金 = 承诺 − 编排费 − 通道费，平台分成恒 0）；结算 7 态流转。 |
| `lib/applications.js` | 统一 S0–S10 状态机：每阶段 owner/status/起止/deadline/待办/材料/消息/审计；看板、时间线、列表三视图；材料 C→B→S 三方确认；OCR 家庭库与授权。 |
| `lib/supplier.js` | 六类供应商统一模型。类型差异只在 `SupplierProfile.extensions`，不复制六套系统。 |
| `lib/payments.js` | AETHEL X 支付编排：PaymentIntent → PaymentRoute → PaymentProvider → PaymentReceipt / Refund / FeeBreakdown / CommissionTrigger。NexusPay/Stripe/Bank/Manual/Other 五种适配器，默认 Sandbox。 |
| `lib/seed.js` | 演示数据：3 家 B（含 1 家 Free 用于验证准入拒绝）、6 类 S、DBC、Admin、学生；演示佣金规则明确标 `is_demo`。 |

### 2.2 HTTP API（`api-server.js`）

一个 Express 应用服务全部客户端：

```
/api/public/*   公开发现（学校、供应商、住宿、参考字典）— 无需登录
/api/auth/*     注册 / 登录 / Demo 一键登录 / 会话
/api/c/*        C 端（学生 / 家长）
/api/b/*        B 端（留学机构）
/api/s/<type>/* S 端（education/medical/certification/visa/accommodation/finance）
/api/dbc/*      DBC 端（仅状态 A）
/api/ads/*      广告中心
/api/admin/*    平台管理端
```

### 2.3 公网客户端（`public-world/`）

| 路由 | 客户端 | 说明 |
| --- | --- | --- |
| `/` | 客户端选择器 | 只负责选择，无宣传长页 |
| `/student` | 学生 / 家长 | 待绑定限制、需求、推荐、绑定、申请、材料、支付、评价、消息、简报 |
| `/agent` | 留学机构 | 绑定处理、客户池、S0–S10 看板、资源中心、佣金结算、团队、健康度、智能助手 |
| `/dbc` | DBC | 状态 A 协议 / 供应商 / 招生 / 结算；状态 B 完全不可见 |
| `/supplier/education` | 教育机构 | 招生状态机、看板、材料确认、佣金 |
| `/supplier/medical` | 体检机构 | 委托、预约、状态、报告（不存诊断） |
| `/supplier/certification` | 文件认证 | 学历/成绩/公证/翻译认证流程 |
| `/supplier/visa` | 签证代办 | 委托、材料、预约、递交、补件、结果 |
| `/supplier/accommodation` | 学生住宿 | 房间/床位库存、预订、入住、退宿、续期 |
| `/supplier/finance` | 教育金融 | **默认关闭**，显示 Coming soon |
| `/ads` | 广告中心 | 充值→选位→订单→付款→素材→审核→排期→投放→报表 |
| `/admin` | 平台管理端 | 需登录，不出现在公网导航 |
| `/institution` | 供应商统一入口 | 六类供应商选择 |

共享运行时 `public-world/js/gs.js`：i18n（中文默认 / English 切换 / localStorage 持久）、HTTP 封装、渲染助手、底部抽屉、登录面板、Footer 运营方署名。

---

## 3. 硬规则落地方式

规则不是文档说明，而是代码路径：

| 规则 | 实现位置 | 测试 |
| --- | --- | --- |
| 1 C 可自主发现平台 | `/api/public/*` + `/student` 发现页 | `public supplier list` |
| 2 C 不能无主 | `binding.cCapabilities()` + `requireBoundC` 中间件 | 6 项 unbound 限制测试 |
| 3 Level 2 → Level 1 → Browse Only | `recommendation.recommend()` 分级 | 4 项分级测试 |
| 4 B 推荐硬准入 | `recommendation.evaluateAdmission()` 14 项 | 12 项准入测试 |
| 5 推荐评分 + 公平轮换 | `scoreCandidate()` + `fairRotationScore()` | 9 项评分测试 |
| 6 3–5 家推荐 | `recommendation_pool_size` | 1 项池测试 |
| 7 绑定 + 双签 | `binding.signBinding()` | 6 项绑定测试 |
| 8 C 与 S 隔离 | `stripForC()` + 权限矩阵 + 公开视图 | 4 项隔离测试 |
| 9 佣金 | `contracts.computeCommission()` | 7 项佣金测试 |
| 10 C 自主付款归属 B | `triggerCommissionForPayment()` | 2 项归属测试 |
| 11 统一 AETHEL X | `payments.createIntent/confirm/refund` | 6 项支付测试 |
| 12 首绑保护 12 个月 | `rebindingCheck()` + `requestRebinding()` | 3 项保护测试 |
| 13 B 到期 + 30 天宽限 | `expireMembership()` + `handleBMembershipExpiry()` | 5 项到期测试 |

---

## 4. 数据持久化（如实说明）

`GET /api/health` 的 `backend` / `persistence` 字段实时报告真实后端：

| 环境 | 后端 | 是否持久化 |
| --- | --- | --- |
| 设置 `DATABASE_URL` 且安装 `pg` | `postgresql` | 是（PostgreSQL） |
| 默认（本地 / Render 免费档） | `json-file` | **是**，写入 `GS_DB_DIR/aethel.json`，进程重启不丢失（有自动化测试覆盖） |
| `GS_DB_MEMORY=1` | `memory` | 否，仅用于隔离单测 |

**未声称不存在的持久化**：默认 JSON 文件后端是真实持久化，不是内存。切换到 PostgreSQL 只需设置 `DATABASE_URL`（已列入 `render.yaml` 的 `sync: false` 环境变量），代码零改动。

---

## 5. 外部能力（全部 Sandbox，不伪造）

`config.providers` 中 10 类外部能力默认 `mode: "sandbox"`：

`payment / ocr / kyc / aml / sms / email / whatsapp / wechat / signature / blockchain_evidence`

- OCR 分类明确标注 `sandbox: true`，是 Mock，不是真实识别。
- 电子签走 `signature` 适配器，`provider_mode` 透出为 `sandbox`。
- 支付全部走 Sandbox Provider，`receipt.sandbox === true`，UI 有 Sandbox 提示条。
- **没有假装完成任何真实跨境支付。**

---

## 6. 合规边界（本轮不做）

- 教育金融（FINANCE）：路由存在，功能默认关闭，不实现信用评分 / 自动审批 / 放款 / 还款 / 逾期催收 / 实际金融交易。
- 保险：同为预留 + 关闭。
- 复杂 FX 交易：只存 `currency` / `reference_rate` / `rate_timestamp` 三个字段。
- 正式金融风控、自动催收：不做。

---

## 7. 测试

`npm test` 全绿，共 **282 项**断言，7 个测试文件：

| 文件 | 断言数 | 覆盖 |
| --- | --- | --- |
| `tests/full-mvp-core.test.js` | 115 | 规则 2–13、S0–S10、RBAC、房间库存、Finance flag、DBC 隔离、Demo/Verified、审计、配置、持久化 |
| `tests/full-mvp-api.test.js` | 86 | HTTP 层：认证、RBAC 跨端隔离、公开 API 隔离、完整绑定 E2E、S0–S10、材料三方确认、支付/佣金/退款、六类 S、DBC 状态 A、Admin、广告漏斗、消息/简报、重启持久化、Web shell |
| `tests/smoke.test.js` | 23 | V1 应用启动与 API |
| `tests/v1.test.js` | 24 | V1 搜索 / 详情 / 对比 / 导入 / 审核 |
| `tests/v1.0.1.test.js` | 12 | 真实数据导入与来源规则 |
| `tests/v1.1.test.js` | 22 | Growth Center（内部能力，仍受测） |
| `tests/public-mvp.test.js` | — | 公网隔离与客户端可达性 |

CI：`.github/workflows/ci.yml`，Node 18 / 20 双矩阵，除 `npm test` 外还做 13 个公网客户端的可达性、中文默认 + English 切换、内部 API 401 / 已移除路由 404、公开 API 不含佣金与私人联系方式、Demo 登录 E2E、Finance 403、持久化后端如实上报。

---

## 8. 已知限制

1. **地图瓦片未接入**：提供结构化坐标与临近站点（haversine 直线距离），`tile_provider` 恒为 `null`，UI 显示诚实占位，不伪造地图。
2. **住宿"附近"只按经纬度直线距离**：明确不虚构通勤时间。
3. **演示学校数据**：`is_demo: true`，前端标注"演示数据"。
4. **演示佣金规则**：仅用于验证计算逻辑，标注"不代表真实商业条款"。
5. **短信 / 邮件 / 微信 / WhatsApp**：Provider Adapter 就绪，未配置真实 Provider 时为 Sandbox。
6. **社交登录**：入口预留，未接入真实 OAuth（需本人授权）。

---

## 9. 下一步建议

1. 接入 PostgreSQL（Render Postgres / Supabase / Neon 免费档），设置 `DATABASE_URL` 即切换，无需改代码。
2. 用真实学校数据替换演示数据：走 `/api/admin/import` 流程，补 `source_url` / `supplier_evidence` 后才可 Verified。
3. 接入真实电子签与支付 Provider（需本人授权），把 `providers.*` 切到 `live`。
4. 开启 FINANCE / INSURANCE 功能开关前，先补齐合规审查与风控流程。
5. 为学生端增加收藏 / 对比的服务端化（当前仍在 localStorage）。
6. 补充 B 端团队邀请的真实邮件触达（当前站内信已可用）。
