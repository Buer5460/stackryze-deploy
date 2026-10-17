# FULL MVP V3 — 架构文档

**版本**：3.0.0 ｜ 技术栈：Node.js 18/20 + Express 4 ｜ 无构建步骤、无前端框架

---

## 1. 总体结构

```
浏览器（手机优先 H5，中文默认 / English 切换）
   │  fetch + Bearer Token（或 Demo Token）
   ▼
api-server.js                    ← 唯一 HTTP 入口（V3）
   ├── /api/public   公开发现（学校/供应商/住宿/字典）
   ├── /api/auth     注册/登录/Demo 一键/会话
   ├── /api/c        C 端（学生/家长）
   ├── /api/b        B 端（留学机构）
   ├── /api/s/:type  S 端六类（同一路由工厂，按 type 装配）
   ├── /api/dbc      DBC（仅状态 A）
   ├── /api/ads      广告中心
   └── /api/admin    平台管理（必须登录）
   ▼
lib/ 领域层（纯 Node 模块，无框架耦合）
   ├── db.js             持久化（PostgreSQL / JSON 文件 / 内存）
   ├── auth.js           19 角色 RBAC + 会话
   ├── config.js         全部策略后台可配置
   ├── audit.js          审计 + 脱敏
   ├── org.js            机构 / 会员 / B 档案
   ├── binding.js        C 档案 / 绑定 / 首绑保护 / 换绑
   ├── recommendation.js 规则 3-6 推荐引擎
   ├── contracts.js      合同 / 佣金 / 结算
   ├── applications.js   S0–S10 状态机 / 材料 / 授权
   ├── supplier.js       六类供应商统一模型
   ├── payments.js       AETHEL X 支付编排
   ├── seed.js           演示数据
   └── util.js           ID / 时间 / 金额 / 距离
   ▼
data/db/aethel.json（默认后端）或 PostgreSQL aethel_kv 表
```

沿用资产（未重做）：`server.js`（V1 搜索引擎与导入/审核）继续作为 `api-server.js` 的依赖提供 `/api/public/schools`；`server-public.js` 保留为 V1 公网壳；`lib/growth.js` 等内部能力保留但不出公网路由。

---

## 2. 一个体系，五个端

| 维度 | 实现 | 位置 |
| --- | --- | --- |
| 数据模型 | 60+ 集合，五端共用 | `lib/db.js` COLLECTIONS |
| 状态体系 | S0–S10 唯一状态机 | `lib/applications.js` + `lib/auth.js` STAGES |
| 合同体系 | 5 类协议 + 版本 + 双签 + 证据 | `lib/contracts.js` |
| 佣金体系 | 7 种规则模式 + 台账 7 态 + 结算 | `lib/contracts.js` |
| 支付编排 | Intent → Route → Provider → Receipt/Refund | `lib/payments.js` |
| 审计体系 | 全变更留痕 + 脱敏 | `lib/audit.js` |

**禁止复制多套系统**：S 端六类用同一个 `sRouterFor(type)` 工厂生成，类型差异只在 `SupplierProfile.extensions`；B/C/S/DBC/Admin 的差异只体现在 RBAC 权限与路由门，不在数据模型。

---

## 3. 关键流程

### 3.1 绑定（规则 7）
```
C 选 B ──► BindingRequest(pending_b_request)
        ──► B accept（先过接单上限闸）──► 生成 B_C 合同(pending_contract)
        ──► C 电子签(pending_b_signature)
        ──► B 电子签 ──► 合同 active
        ──► activateBinding：C.binding_state=active + 开通免费 C 席位
        ──► 若为换绑：审计佣金归属变更
```
平台只记录合同，不是业务一方；`agreements.body` 内置该声明。

### 3.2 推荐（规则 3–6）
```
requirement ──► 对全部 B 跑 evaluateAdmission（14 项硬准入，任一失败即排除并记录原因）
            ──► 合格池按 level 分层：LEVEL_2 优先，空则 LEVEL_1，再空则 browse_only
            ──► 层内按六维加权总分排序（需求匹配35/质量信任25/响应15/公平轮换10/合作深度10/扰动5）
            ──► 取前 3–5 名；B 接受后写入 rotations 供轮换统计
```
广告预算不进入评分；`ad_budget_affects_ranking` 恒 false。

### 3.3 S0–S10
```
createApplication ──► 一次性铺开 11 个 stage 骨架 + 每阶段待办落库
transition(from→to)：
  1. 校验合法流转（只允许顺序）
  2. 校验当前阶段待办全部 done（否则 STAGE_TODOS_INCOMPLETE）
  3. 关闭旧阶段、开启新阶段、写 timeline、写审计
  4. 到达 S10 触发 APPLICATION_REACHED_S10 佣金事件
```

### 3.4 材料三方确认
```
C 上传（OCR=Sandbox Mock，明确标注）──► uploaded
B 确认 ──► b_confirmed        （S 先确认 → 400 "必须先由 B 确认"）
S 确认 ──► s_confirmed
S 读家庭库 ──► 需 document_authorizations 显式授权（可撤销、可过期）
```

### 3.5 支付与佣金（规则 9–11）
```
PaymentIntent(kind, amount, currency, payer)
  └─► PaymentRoute → PaymentProvider（sandbox 默认）
  └─► confirm ──► PaymentReceipt(sandbox:true, reference)
       └─► PAYMENT_SUCCEEDED ──► 匹配 CommissionRule
            └─► computeCommission: net = committed − 编排费(2.5%) − 通道费(1.8%)
                 platform_share_of_net ≡ 0（平台不参与 B 净佣金分成）
                 ledger.b_organization_id = 绑定 B（即使 C 自主付款，规则 10）
refund ──► intent.status=refunded + 关联台账 → clawed_back
```

### 3.6 DBC 状态 A / B 隔离
```
状态 A：S → DBC → AETHEL X → B    DBC 全程可见、可结算
状态 B：B ↔ S 直连                 DBC 路由强制 state='A' 过滤 → 完全不可见
```

---

## 4. 持久化设计

| 后端 | 触发条件 | 说明 |
| --- | --- | --- |
| PostgreSQL | `DATABASE_URL` 已设且 `pg` 可装 | 单表 `aethel_kv(collection, id, doc jsonb)`，启动全量加载，写路径 UPSERT |
| JSON 文件 | 默认 | `GS_DB_DIR/aethel.json`，20ms 防抖写透 + `exit/SIGINT/SIGTERM` 强制 flush；临时文件+rename 原子替换 |
| 内存 | `GS_DB_MEMORY=1` | 仅供隔离单测 |

`GET /api/health` 的 `backend`/`persistence` 字段实时如实上报，不虚报。
新增实体无需迁移文件：加入 COLLECTIONS 即获得同一套 CRUD 与持久化。

---

## 5. 安全与隔离

- **RBAC**：19 角色 → 权限矩阵；每条路由经 `requireC/requireB/requireS(type)/requireDBC/requireAdmin` 门；跨端访问一律 403（先查 audience 再查档案，避免 404 泄露）。
- **Rule 8**：C 侧所有供应商响应经 `stripForC()` 递归剔除 `commission*` 与 `contact_phone/email/whatsapp`。
- **Rule 9**：C 端任何响应不含 `net_to_b` / `commission_rule`（有测试断言）。
- **审计脱敏**：`password/token/secret/card/cvv/authorization` 不落审计。
- **安全响应头**：nosniff / Referrer-Policy / Permissions-Policy / X-Frame-Options。
- **Admin 隐藏**：不出现在公网导航；`/api/admin/*` 未登录一律 401。
- **生产秘密**：只走环境变量（`DATABASE_URL` 等 `sync: false`），前端零秘密。

---

## 6. 前端架构

- 无框架、无构建：静态 HTML + 共享运行时 `public-world/js/gs.js`。
- `gs.js`：i18n（zh 默认/en 切换/localStorage 持久）、fetch 封装（401 自动登出）、渲染助手（卡片/状态 Tag/指标/表格/Kanban/Timeline/底部抽屉）、登录面板、Footer 署名。
- 视觉延续 V1 `app.css`（ navy/cyan 渐变、卡片、Bottom Sheet），新增组件全部沿用同一变量体系；375/390/430px 移动端优先。
- 扩展路由 `/student`、`/agent`、`/supplier/*` 等由服务端映射到对应 HTML；`.html` 旧别名保留。

---

## 7. 部署

- Render Blueprint（`render.yaml`）：`npm install` + `npm start`，健康检查 `/api/health`。
- 自动部署分支：`global-study-mvp`（`main` 从不动）。
- `GS_DB_DIR=/var/data`（Render 持久盘）+ 可选 `DATABASE_URL`。
- 回滚：`git revert <sha> && git push`（Render 自动重部署），5 分钟内完成；数据文件在持久盘不受回滚影响。

---

## 8. 权衡记录

| 决策 | 理由 |
| --- | --- |
| KV 单表而非 60 张关系表 | 本轮实体多且演进快；KV + 集合即可表达全部关系，Postgres 迁移零成本；不牺牲持久化承诺 |
| JSON 文件为默认后端 | Render 免费档无免费 Postgres；文件持久化真实可用且有跨重启测试，诚实标注优于假装有 DB |
| 无前端框架 | 延续既有单文件 H5 资产与视觉，避免重写 UI（任务明确禁止） |
| 佣金费率全部走 CommissionRule | 规则 9 明令禁止写死 15/20/25/35%，演示值也必须显式建规则 |
| 状态 B 由 Admin 记录 | 平台记录不等于参与；DBC 路由强制 state='A' 过滤保证隔离（有测试） |
