# FULL MVP V3 — 测试报告

**版本**：3.0.0 ｜ **分支**：`workbuddy/aethel-full-mvp-v3` ｜ **日期**：2026-10-17

---

## 总览

```
npm test   →  282 passed, 0 failed
CI         →  Node 18 / Node 20 双矩阵
```

| 测试文件 | 断言 | 结果 |
| --- | --- | --- |
| `tests/full-mvp-core.test.js` | 115 | ✅ 全绿 |
| `tests/full-mvp-api.test.js` | 86 | ✅ 全绿 |
| `tests/smoke.test.js` | 23 | ✅ 全绿 |
| `tests/v1.test.js` | 24 | ✅ 全绿 |
| `tests/v1.0.1.test.js` | 12 | ✅ 全绿 |
| `tests/v1.1.test.js` | 22 | ✅ 全绿 |
| `tests/public-mvp.test.js` | — | ✅ 全绿 |

---

## 1. 核心规则测试（`full-mvp-core.test.js`，115 项）

### Rule 2 — C 端不能"无主"（5 项）
- C 自主注册后进入 `unbound`
- 未绑定：可浏览 / 可搜索 / 可看费用 / 可提交需求；**不可下单、不可付款、不可上传材料、不可购买服务**
- 未绑定：**永远不可见佣金、永远不可直接联系 S**
- 未绑定 C 创建申请返回 `C_UNBOUND`
- 绑定后完整服务开启

### Rule 3 — 推荐分级（4 项）
- 有合格 Level 2 时优先 Level 2
- 无合格 Level 2 才降级 Level 1
- 都不合格 → Browse Only
- **Level 1 永远不能排在符合条件的 Level 2 前面**（用"低分 Level 2 vs 高分 Level 1"验证）

### Rule 4 — B 推荐硬准入（12 项）
未认证 / Free 会员 / 财务资料不全 / KYC 不合格 / KYB 不合格 / 合同无效 / 机构冻结 / 未解决严重争议 / 暂停推荐 / 达到接单上限 / 国家不匹配 / 阶段·课程·服务类型·语言不匹配 / 状态 A 不可执行 —— 任意一项失败即被移出推荐池，并记录具体 `failures`。

### Rule 5 — 推荐评分与公平轮换（9 项）
- 默认权重 35/25/15/10/10/5，合计 100
- 权重后台可配置
- 六个评分维度全部产出 0–100 分
- 评分高的 B 质量信任分更高；响应快的 B 响应分更高
- 最近被推荐多的 B 轮换分被压低（反霸榜）
- 小 B 有最低曝光保底
- 新 B 有冷启动保护
- 随机扰动按天确定性（可重现）
- 广告预算不影响自然排名

### Rule 6 — 3–5 家推荐（1 项）
候选数受 `recommendation_pool_size` 约束在 1–5 之间。

### Rule 7 — 绑定与双签（6 项）
绑定申请 → B 接受生成 B-C 合同 → C 签 → B 签 → 合同生效 → C 席位免费开通 → 进入 Bound；重复签署被拒；平台仅记录合同（合同正文含"平台不作为业务一方确认业务结果"）。

### Rule 8 — C 与 S 隔离（4 项）
公开供应商视图**不含** `contact_phone` / `contact_email` / `contact_whatsapp`；B 视图可见合作条件 + 佣金规则；演示协议**不泄露任何佣金数值**；无协议显示"暂无合作协议"。

### Rule 9 — 佣金（7 项）
- `净佣金 = 承诺佣金 − AETHEL X 编排费 − 支付通道费`（15% × 1000 = 150 → 编排费 3.75 + 通道费 2.7 → 净 143.55）
- 平台对 B 净佣金分成恒为 **0**
- 固定人头 / 阶梯模式计算正确
- 佣金绑定 Supplier + Product + B + Agreement + Rule
- **协议上不写死任何百分比**，必须显式建 CommissionRule
- 台账生命周期 `projected → confirmed → receivable → received → payable → paid`
- 结算单只允许按流程单步推进，非法跳跃被拒

### Rule 10 + 11 — AETHEL X Sandbox（8 项）
Intent 创建 → `requires_action` → Sandbox 确认成功 → 凭证签发；五种 Provider 适配器齐备；非法类型 / 零金额 / 负金额被拒；退款成功并**扣回已产生佣金**；多币种字段（`reference_rate` / `rate_timestamp`）记录且无 FX 引擎。

### Rule 12 — 首绑保护（3 项）
默认 12 个月且后台可配置；保护期内换绑需"原 B 同意 + 新 B 同意 + 平台审核"三步，任一步缺失即拒绝；佣金归属变更写入审计。

### Rule 13 — B 到期（5 项）
提醒天数 60/30/7/1；宽限默认 30 天；宽限期内会员仍有效；宽限期外失效；到期后绑定中的 C 转平台服务并留审计；续费生成新会员并停用旧会员。

### S0–S10 状态机（8 项）
11 阶段齐全且每阶段有 owner；只允许顺序流转；创建申请即铺开完整 S0–S10 骨架；有未完成待办时禁止前进；看板 / 时间线 / 列表三视图；到达 S10 触发佣金事件。

### 材料与授权（5 项）
确认顺序强制 C → B → S（S 先确认被拒）；S 读材料必须显式授权；授权可撤销；一次上传多申请复用；9 类材料字段齐全。

### RBAC（7 项）
19 个角色全部定义；C 角色永远无结算 / 佣金权限；B_VIEWER 不能动钱；S_FINANCE 不能碰招生；DBC 无 B 结算与 C 绑定权限；ADMIN_SUPER 通配；未知角色零权限且建号被拒。

### 住宿库存（3 项）
`beds_available = beds_total − beds_occupied`；超售钳到 0 不为负；四种住宿类型 + 五种房型。

### Finance（4 项）
`FINANCE_ENABLED` 默认 false；公开视图显示 Coming soon；扩展明确禁用评分 / 审批 / 放款；未来类型（INSURANCE/TRAINING/TRANSLATION/TRANSPORT/OTHER）仅预留。

### DBC 隔离（3 项）
只见状态 A；状态 B 查询结果为空；DBC 不持资金、不分成。

### Demo / Verified（3 项）
无来源不能核验通过；AI 禁止补字段清单齐全（学费 / 录取率 / 排名 / 佣金 / 利率 / 床位 / 签证成功率）；演示数据必须标注。

### 审计（3 项）
变更动作全部留痕；条目含 actor / entity / before-after；密钥字段自动脱敏。

### 供应商统一模型（4 项）
六类全部支持且共用一套档案与视图；录取状态机与规格逐字一致；体检不存诊断。

### 配置与持久化（5 项）
配置持久化并带历史；可恢复默认；10 类 Provider 默认 sandbox；品牌 Footer 文案；广告演示默认值可配置（800 / 100 / 6 不写死）；**JSON 文件后端跨重启不丢数据**。

---

## 2. HTTP API 测试（`full-mvp-api.test.js`，86 项）

| 分组 | 项数 | 要点 |
| --- | --- | --- |
| Auth | 11 | 健康检查、meta、注册、重复邮箱 409、错密码 401、登出失效、401 兜底 |
| Public API 隔离 | 7 | 公开供应商无佣金 / 无私人联系方式；Finance Coming soon；内部路由 401；已移除路由 404；未知 API 返回 JSON 404 |
| RBAC 跨端隔离 | 10 | C 不能进 B/S/DBC/Admin；B 不能进 C/Admin/DBC；S 不能进别的供应商类型；DBC 不能进 B/C/S/Admin；Admin 不能用客户端写接口 |
| Rule 2 HTTP | 3 | 未绑定被申请 / 支付 / 材料接口 403；可浏览与读能力 |
| 绑定 E2E | 6 | 需求 → Level 2 推荐 → 选 B → B 接受 → 双签 → 生效；重复绑定 409；合同双签记录 |
| S0–S10 | 5 | 建申请、待办阻塞、非法跳跃拒绝、S0→S10 全走、看板 / 时间线 |
| 材料 | 4 | C 上传 → B 确认 → S 确认；S 不能抢先；授权门禁 |
| 支付 / 佣金 | 7 | Sandbox 支付、凭证、佣金归绑定 B、C 侧无佣金字段、退款扣回、B 汇总七态、结算单步进 |
| 六类 S | 6 | 教育录取状态、体检（无诊断）、认证、签证结果、房间库存不超售、Finance 403 |
| DBC | 3 | 只见状态 A、可建状态 A 协议、B 不可见 |
| Admin | 8 | 仪表盘、推荐池准入、权重调整、会员到期转移、无来源拒核验、审计日志、配置读写、争议裁决、助手不越权 |
| 广告 | 5 | 演示默认值、完整漏斗、供应商不能自审、CTR/CVR/ROI 与排名规则声明、续费上限 |
| 消息 / 简报 / 待办 | 3 | 三端互通、四端简报、待办按端隔离 |
| 持久化 | 1 | **关库重启后用户 / 申请 / 绑定 / 佣金数量一致** |
| Web shell | 4 | 选择器中文默认 + English、全部路由可达、无内部 Growth 文案、SPA 兜底 |

---

## 3. CI（`.github/workflows/ci.yml`）

Node 18 / Node 20 矩阵，除 `npm test` 外：

1. 13 个公网客户端全部 `200`
2. 每个客户端 `lang="zh-CN"` + 含 `English` 切换 + 含运营方署名
3. 内部 API 全部 `401`，已移除的 V1 路由全部 `404`
4. 公开供应商接口不含 `commission_value` / `contact_phone` / `contact_whatsapp`
5. Demo 登录 → 取 token → `/api/auth/me` 成功
6. `/api/s/finance/me` 返回 `403` + `FINANCE_DISABLED`
7. `/api/health` 如实上报持久化后端

---

## 4. 复现方式

```bash
npm install
npm test                 # 282 项
npm start                # http://localhost:3000
GS_DB_MEMORY=1 npm start # 隔离单测模式（不落盘）
DATABASE_URL=postgres://... npm start   # 切换 PostgreSQL
```

---

## 5. 明确未覆盖 / 未做

- 未接入真实第三方 Provider（OCR / KYC / 支付 / 电子签 / 短信 / 邮件 / 微信 / WhatsApp），全部 Sandbox。
- 未做社交登录 OAuth（需本人授权）。
- 未做地图瓦片（只提供结构化坐标与直线距离）。
- 未做真实金融业务（贷款 / 保险）。
- 未做复杂 FX 交易。
- 收藏 / 对比仍在前端 localStorage（V1 行为延续）。
- 性能 / 压力测试未做（免费档 Render 单实例）。
