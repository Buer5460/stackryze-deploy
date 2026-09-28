# Growth Center 标准作业流程（SOP）

本 SOP 规定增长团队使用 Growth Center 的标准动作、转化纪律与红线。目标是把「外部机构/院校/红人/KOL」有序转化为「已入驻、已激活的 B 端合作伙伴」。

## 一、角色与权限
- 可用角色：`growth_admin, growth_manager, bd, sales, marketing, ops, admin`。
- 外部 B/S/C/供应商学生 **禁止访问**（API 403；H5 角色选择不含这些外部角色进入 Growth）。
- 与「B 端工作台（agency workspace）」严格分离，两者数据、入口、权限互不可见。

## 二、线索获取与录入（Lead Intake）
1. 来源必须可核验：院校官网 / 官方教育监管机构 / 官方学校目录 / 已验证供应商提交。
2. 录入时填写 `organization_name, persona_type, country, website/email/phone, source_url, source_confidence`。
3. **无 `source_url` 只能建草稿级线索**，不得标为已核验；`value`/事实禁止编造（AI 仅用于发现来源与结构化整理，不能作为事实来源）。
4. 批量导入：逐条 POST 或导入流程，导入后看板计数立即反映。

## 三、去重纪律（Dedup）
1. 系统按 `domain/email/phone/org/linkedin/social` 判定：
   - 任一 `email|phone|domain|org` 精确命中 → `exact_match`（**返回 409，不写入第二条记录**）。
   - 有重叠但非精确 → `probable_match`。
2. 重复线索进入「重复审查」：选择 **合并（merge）/ 保持分离（keep-separate）/ 忽略（ignore）**。
3. 合并时保留填缺（以非空补空）并写入 `merge_history`，**不丢弃任何既有证据**。

## 四、富集与评分（Enrich & Score）
1. 追加 `LeadEvidence`：`field, value, source_url, captured_at, confidence`。**value 必须来自来源或人工**。
2. 评分：`ScoreModel` 感知，0–100 分，A/B/C/D 四级，给出可解释理由；支持多模型切换 `active`。
3. 评分结果写回线索（`score / score_tier / score_model / score_reason`），保留历史。

## 五、触达（Outreach，人工介入）
1. 入队默认 `queued`（草稿）。**禁止系统自动发送**——人工复核内容后改为 `approved → sent`。
2. `do_not_contact` / `opt_out` 线索**不得入队**。
3. 每次沟通记录 `Communication`（渠道、结果）；`result=opt_out` 自动置 `do_not_contact`。

## 六、转化纪律（严格路径，强制）
**Lead → Opportunity → Organization → Onboarding → BEndAccount**
1. 线索建商机（Opportunity），进入 S0。
2. 阶段推进 S0–S8：**S5（Agreement）才创建 Organization**，并写入 `lead_attribution`（来源类型/名称/URL/采集时间）。
3. S6 关联组织。
4. 启动入驻（10 步），**全部完成后才创建 B 端账号（BEndAccount）**，继承 `lead_attribution`。
5. **绝不允许 Lead 直接变为 B 账户**——所有归因必须经由 Organization 透传，确保来源可追溯。

## 七、激活（Activation）
- B 账户产生 `first_application` / `first_commission` 等生命周期事件时记录时间戳，看板据此统计「已激活 B / 首次申请 / 首次佣金」。

## 八、活动（Campaign）
- 创建活动并设定目标画像/国家/渠道；看板聚合目标线索数与转化漏斗。

## 九、红线（不可逾越）
- 不编造院校/机构/佣金/排名/学生数等事实。
- 无 `source_url` 或有效供应商证明，不得进入已核验。
- 演示数据 `is_demo=true`；真实数据 `is_demo=false`，严格隔离。
- 本阶段不开发保险/贷款/住宿交易/复杂支付（仅保险架构预留，flag 关闭）。
- 不自动启动 V1.2 会员收费。

## 十、异常处理
- 发现重复但未被系统捕获：手动「重复审查 → 合并」，并补 `merge_history` 备注。
- 误触达 opt-out 线索：系统已拦截（400）；若人工误标，撤销 `do_not_contact` 需管理员复核。
