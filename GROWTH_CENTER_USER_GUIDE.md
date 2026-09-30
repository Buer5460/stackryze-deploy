# Growth Center 用户手册（User Guide）

面向平台内部 **增长团队**（growth_admin / growth_manager / bd / sales / marketing / ops）与 **admin**。外部 B/S/C/供应商学生不可访问（API 返回 403）。

> Growth Center 与「B 端工作台（机构 agency workspace）」是**两个独立的 B 端**，互不混用。

## 0. 如何进入
- 打开 H5（线上 `https://global-study-mobile-mvp.onrender.com`），在角色选择页选择 **Growth Center / BD / 销售 / 市场 / 运营 / admin**。
- 顶部导航出现：**★ 看板 / ♟ 线索池 / ✉ 触达 / ◈ 商机 / ▦ 活动**（角色不同可见项略有差异）。
- `admin` 用户在「平台管理后台」顶部可见「★ Growth」入口跳转。
- API 调用需在请求头带 `x-role: bd`（或其它增长角色），例如：
  ```bash
  curl -H "x-role: bd" https://global-study-mobile-mvp.onrender.com/api/growth/leads
  ```

## 1. 看板（Dashboard）
- 一屏掌握：线索总数、新阶段数、分层分布（A/B/C/D）、商机数、已入驻 B、已激活 B、首次申请、首次佣金、免打扰数。
- 支持按 persona / country / score_tier / source_type 过滤（API `?persona=&country=&score_tier=&source_type=`）。

## 2. 线索池（Leads）
- **新建线索**：填写机构名、画像（persona）、国家、官网/邮箱/电话、学生池、是否接受佣金、来源 URL。
  - 无 `source_url` 仍可创建，但为**草稿级**，不计入已核验（符合来源校验红线）。
- **列表**：显示线索、画像标签、评分等级徽章、阶段、来源类型。
- **线索详情抽屉**支持：
  - **评分**：基于当前 ScoreModel 计算 0–100 分与 A/B/C/D 等级，给出可解释理由。
  - **富集/证据**：追加 `LeadEvidence`（字段、值、来源 URL、置信度）；**值必须来自来源或人工，禁止编造**。
  - **建商机**：一键由线索创建 Opportunity（进入 S0）。
  - **入队触达**：加入触达队列（默认 `queued` 草稿，人工复核后发送）。
  - **重复审查**：若系统判定为 `exact_match` / `probable_match`，在此选择 合并 / 保持分离 / 忽略，并保留 `merge_history`。

## 3. 触达（Outreach，人工介入）
- 触达任务默认 `queued`（草稿）。流程：`queued → approved → sent → replied…`。
- 已 `do_not_contact` / `opt_out` 的线索**无法入队**（避免骚扰）。
- 沟通记录（Communication）：每次触达交互与结果写入线索时间线；`result=opt_out` 自动置 `do_not_contact`。

## 4. 商机（Opportunities，S0–S8）
- 由线索创建，阶段严格推进：S0 Discovery → S1 Evaluated → S2 First Contact → S3 Engaged → S4 Negotiation → **S5 Agreement（此时才创建 Organization 并保留线索归因）** → S6 Onboarded → S7 Activated → S8 First Revenue。
- **Lead 绝不直接变成 B 账户**；必须走「线索 → 商机 → 组织 → 入驻 → B 账户」。

## 5. 活动（Campaigns）
- 创建活动（名称、目标画像、国家、渠道、模板），系统预留统计位（目标线索数、联系数、打开、回复、入驻、激活、首收等），看板聚合反映。

## 6. 入驻与激活（Onboarding → B Account → Activation）
- 商机到 S5 后生成 Organization；启动入驻（10 步：注册/主体类型/资料/资质/联系人/目标国家/业务规模/协议/审核/开通）。
- **10 步全部完成后才创建 B 端账号（BEndAccount）**，并继承原始 `lead_attribution`（来源类型/名称/URL）。
- 激活事件：`first_application` / `first_commission` 等，记录生命周期时间戳。

## 7. 保险入口说明
- 当前 **保险功能关闭**（`insurance_enabled=false`），仅为未来 S-end 服务预留架构，界面不展示保险商店。

## 8. 注意事项（红线）
- 不导入无来源的机构/院校事实；不编造佣金、排名、学生数。
- 来源 URL 缺失的线索保持草稿级，不得标为已核验。
- 触达须尊重 `do_not_contact` / `opt_out`。
