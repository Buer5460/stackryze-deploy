# FULL MVP V3 — RBAC 权限体系

**版本**：3.0.0 ｜ 实现：真实 RBAC（角色 → 权限矩阵 → 路由守卫），不是简单的 header 检查

---

## 1. 角色清单（19 个）

| 角色 | 端 | 中文 | 核心权限域 |
| --- | --- | --- | --- |
| ADMIN_SUPER | ADMIN | 平台超级管理员 | `*`（通配） |
| ADMIN_OPERATION | ADMIN | 平台运营 | 用户/审核/推荐/绑定/合同/申请/材料/签证/评价/争议/消息/配置/广告/报告 |
| ADMIN_FINANCE | ADMIN | 平台财务 | 佣金/支付/结算/报告/争议/会员 |
| ADMIN_AUDIT | ADMIN | 平台审计 | 审计日志/报告/绑定/合同（只读） |
| B_OWNER | B | 机构负责人 | B 端全部：档案/会员/KYC/客户/绑定/CRM/资源/申请/材料/签证/支付/合同/结算/绩效/争议/消息/团队/助手/广告 |
| B_COUNSELLOR | B | 顾问 | 客户/绑定/CRM/资源/申请/材料/签证/支付/消息/待办/助手 |
| B_DOCUMENT | B | 材料专员 | CRM/材料/申请/签证/消息/待办 |
| B_FINANCE | B | 机构财务 | 结算/支付/合同/多币种/绩效/报告 |
| B_VIEWER | B | 只读成员 | 档案/CRM/申请/资源（**无资金操作**） |
| C_PARENT | C | 家长 | 档案/发现/需求/推荐/绑定/申请/材料/签证只读/支付/评价/消息/简报/待办/解绑 |
| C_STUDENT | C | 学生 | 同 C_PARENT |
| S_OWNER | S | 供应商负责人 | S 端全部：档案/KYC/产品/申请/材料/签证/佣金/协议/结算/消息/待办/审计/广告/评价 |
| S_ADMISSION | S | 招生专员 | 档案/申请/材料/消息/待办/产品 |
| S_OPERATION | S | 运营 | 档案/产品/申请/材料/消息/待办/广告 |
| S_FINANCE | S | 供应商财务 | 佣金/协议/结算/报告（**无申请**） |
| S_VIEWER | S | 只读成员 | 档案/申请 |
| DBC_OWNER | DBC | DBC 负责人 | DBC 全部：档案/协议/供应商/B/申请/学生/材料/签证/结算/争议/消息/简报/报告/审计 |
| DBC_OPERATION | DBC | DBC 运营 | 供应商/B/申请/学生/材料/签证/消息/待办 |
| DBC_FINANCE | DBC | DBC 财务 | 结算/报告 |

---

## 2. 最小权限硬边界（有测试断言）

| 边界 | 断言 |
| --- | --- |
| C 永远看不到佣金 | `C_PARENT`/`C_STUDENT` 无 `b:settlement` / `s:commission` / `admin:commission` |
| C 永远不能直接联系 S | `cCapabilities().can_contact_supplier === false`（含已绑定状态） |
| B_VIEWER 不能动钱 | 无 `b:payment` / `b:settlement` / `b:contract`，保留只读 `b:crm` |
| S_FINANCE 不碰招生 | 无 `s:application`，保留 `s:settlement` |
| DBC 不参与 B 资金与 C 绑定 | 三个 DBC 角色均无 `b:settlement` / `admin:payment` |
| 未知角色零权限 | `permissionsOf('NOT_A_ROLE') === []`，建号抛错 |
| ADMIN_SUPER 通配 | `hasPermission('ADMIN_SUPER', anything)` === true |

---

## 3. 路由守卫矩阵

每条路由先验 audience，再验业务档案；跨端访问返回 **403**（非 404，避免资源探测），未登录返回 **401**。

| 路由前缀 | 守卫 | 额外约束 |
| --- | --- | --- |
| `/api/public/*` | 无 | 输出经 `stripForC()`：无佣金、无私有联系方式 |
| `/api/auth/*` | 无（login/register/demo 公开） | demo-login 仅映射 `is_demo` 用户 |
| `/api/c/*` | `audience === 'C'` + C 档案存在 | 绑定前仅放行 capabilities/profile/需求/推荐/绑定/公开供应商；其余 `requireBoundC` → 403 `C_UNBOUND` |
| `/api/b/*` | `audience === 'B'` + B 机构存在 | 资源按 `b_organization_id` 过滤 |
| `/api/s/:type/*` | `audience === 'S'` + 供应商类型匹配 | 跨类型访问 403；S 签证机构只看授权学生 |
| `/api/dbc/*` | `audience === 'DBC'` | 全部查询强制 `state === 'A'` |
| `/api/ads/*` | 登录 | 素材审核仅 Admin |
| `/api/admin/*` | `audience === 'ADMIN'` | 未登录 401 |

---

## 4. 学生敏感资料授权（最小权限原则）

材料读取三层控制：

1. **归属**：C 只能读写自己的 `family_documents`；B 只能确认自己名下申请的材料；S 只能确认路由给自己的申请材料。
2. **三方顺序**：S 确认前必须已有 B 确认（顺序有测试）。
3. **显式授权**：S/DBC 读家庭材料库需 `document_authorizations`（scope=read、默认 30 天过期、可撤销）；未授权材料只返回"等待授权"占位，不返回文件。

---

## 5. 权限目录数据来源

单一事实源：`lib/auth.js` 的 `ROLES`。`GET /api/reference` 会返回全部角色的 `id / audience / label / permissions`，前端据此渲染菜单，不维护第二份权限表。修改角色权限只需改 `ROLES`，API 与前端同步生效。
