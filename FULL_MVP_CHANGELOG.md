# FULL MVP V3 — CHANGELOG

## [3.0.0] — 2026-10-17 — FULL MVP V3

**分支**：`workbuddy/aethel-full-mvp-v3` → 合入部署分支 `global-study-mvp`（`main` 未动）

### Added — 统一平台底座
- `lib/db.js`：统一持久化层，三档后端（PostgreSQL / JSON 文件 / 内存）自动选择；60+ 集合共用一套 CRUD；单调 `_seq` 保证排序稳定；退出时强制落盘。
- `lib/auth.js`：19 角色 RBAC 目录、权限矩阵、会话 + Demo 一键登录、守卫工厂（requirePermission/requireRole/requireAudience）。
- `lib/config.js`：全部策略后台可配置（推荐权重、首绑保护、宽限期、到期提醒、佣金费率、功能开关、10 类 Provider、广告演示默认值、品牌）。
- `lib/audit.js`：全量审计（actor/before/after/request_id/ip/denied）+ 密钥脱敏 + 自动记录变更请求。
- `lib/util.js`：ID 前缀体系、haversine 距离、可种子化伪随机。

### Added — 领域模块
- `lib/org.js`：Organization / Membership（Rule 13 到期 + 30 天宽限 + 续费）/ B 档案（Rule 4 准入字段）。
- `lib/binding.js`：C 档案与能力矩阵（Rule 2）、绑定状态机与双签（Rule 7）、首绑保护与换绑（Rule 12）、会员到期转移（Rule 13）、解绑。
- `lib/recommendation.js`：规则 3–6 完整实现 —— Level 2→Level 1→Browse Only 分级、14 项硬准入、六维加权评分（35/25/15/10/10/5）、公平轮换（反霸榜/小 B 保底/冷启动）、接单上限、超时自动切换、广告预算隔离。
- `lib/contracts.js`：5 类协议 + 版本 + 双电子签（sandbox 适配器）+ 证据；7 种佣金模式；净佣金 = 承诺 − 编排费 − 通道费（平台分成恒 0）；台账 7 态；结算单步流转。
- `lib/applications.js`：统一 S0–S10（owner/待办/材料/消息/审计齐全）、Kanban/Timeline/List 三视图、材料 C→B→S 三方确认、OCR 家庭库（Sandbox Mock）+ 显式授权。
- `lib/supplier.js`：六类供应商统一模型（Profile extensions 表达差异）、公开视图（无私有渠道）/ B 视图（含佣金规则）、核验需来源。
- `lib/payments.js`：AETHEL X 编排（Intent→Route→Provider→Receipt/Refund），5 种适配器默认 Sandbox，退款扣回佣金。
- `lib/seed.js`：全端演示数据（3+1 家 B 含准入反例、6 类 S、DBC、Admin、学生、广告位库存），全部显式 `is_demo`。

### Added — HTTP API
- `api-server.js`：`/api/public`、`/api/auth`、`/api/c`、`/api/b`、`/api/s/{education,medical,certification,visa,accommodation,finance}`、`/api/dbc`、`/api/ads`、`/api/admin` 八组路由；按 audience 门禁，跨端 403。

### Added — 公网客户端
- 13 个移动端 H5 客户端：选择器、学生、机构、DBC、五类供应商、Finance（默认关闭）、广告中心、Admin、供应商统一入口。
- 共享运行时 `public-world/js/gs.js`：中文默认 / English 切换（localStorage 持久）、fetch 封装、底部抽屉、登录面板、Footer 运营方署名。
- `app.css` 扩展 Kanban / Timeline / 表格 / 表单 / 阶段条 / 徽章组件，视觉延续既有体系。

### Added — 测试与 CI
- `tests/full-mvp-core.test.js`（115 项）+ `tests/full-mvp-api.test.js`（86 项，HTTP 层含重启持久化）。
- CI（Node 18/20）：13 客户端可达性、中文默认 + English、内部 API 401 / 已移除路由 404、公开 API 无佣金无私有渠道、Demo 登录 E2E、Finance 403、持久化如实上报。
- 合计 **282 项断言全绿**。

### Changed
- `package.json` 3.0.0：`main` → `api-server.js`，`start` → 新服务，新增 `test:core` / `test:api` / `test:legacy` 脚本，`pg` 为可选依赖。
- `render.yaml`：`buildCommand: npm install`，新增 `DATABASE_URL`（sync:false）与 `GS_DB_DIR=/var/data`。
- 选择器/学生/机构客户端迁移到共享运行时与 V3 数据；`.html` 旧别名保留兼容。

### Removed（公网面）
- Growth Center 与 B2B 旧路由不再存在（404，而非隐藏）——V3 用统一 `/api/b`、`/api/admin` 取代；`lib/growth.js` 保留为内部能力并有测试。

### Verified（线上验收，38/38）
- 流程一：C 注册→待绑定→需求→Level 2 推荐→绑定→双签→申请→材料三方确认→S0–S10→Sandbox 支付→佣金归绑定 B。
- 流程二：住宿房间→预订→入住（库存=1）→退宿（库存=2）→佣金规则。
- 流程三：State A（DBC 建 DBC-S 协议、只见状态 A）。
- 流程四：State B 由平台记录，DBC 完全不可见。

---

## [1.1.0] — 2026-09-30 — Growth Center（历史）
B 端获客中台：线索去重/合并/评分/外呼队列/活动/商机/激活/仪表盘；保险架构预留。

## [1.0.1] — 2026-09-28 — 真实数据导入试点（历史）
来源规则（无 source_url/supplier_evidence 不得 Verified）、去重、CSV/JSON 校验、敏感字段强制复审、新鲜度配置、公开纠错入口。

## [1.0.0] — 2026-09-23 — 搜索体验正式版（历史）
学校详情、最多 4 校对比、收藏与提醒、地图数据接口（结构化坐标，未接瓦片）、直线距离、后台审核队列与导入工具。

## [0.5.0] — 2026-09-21 — 数据底座与搜索引擎（历史）
C/B/S/Admin 四端 H5、学校搜索筛选、20 条演示学校、三城地区与课程字典、Render 部署。
