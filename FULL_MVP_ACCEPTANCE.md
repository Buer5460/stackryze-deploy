# FULL MVP V3 — 线上验收报告

**验收日期**：2026-10-17 ｜ **环境**：Render 生产（https://global-study-mobile-mvp.onrender.com）｜ **结论：通过（38/38）**

---

## 1. 部署状态

| 检查 | 结果 |
| --- | --- |
| `GET /api/health` | `{"ok":true,"status":"ok","service":"aethel-edu-globalstudy","version":"3.0.0"}` ✅ |
| Render 服务 | `global-study-mobile-mvp`（Free / Node）Live ✅ |
| 自动部署分支 | `global-study-mvp`（`main` 未修改）✅ |
| Health Check 路径 | `/api/health`（render.yaml 配置）✅ |
| 持久化上报 | `backend: "json-file"`，`persistence: "JSON file store (durable across restarts)"` ✅ |

## 2. 公网客户端可达性（13/13 = 200）

`/` `/student` `/agent` `/dbc` `/supplier/education` `/supplier/medical` `/supplier/certification` `/supplier/visa` `/supplier/accommodation` `/supplier/finance` `/ads` `/admin` `/institution`

每个客户端均满足：`lang="zh-CN"`（中文默认）+ `English` 切换 + "Powered by Aethel Edu / 由安世达教育提供核心动力" 署名。

## 3. 隔离与安全验收

| 检查 | 结果 |
| --- | --- |
| `/api/admin/dashboard` `/api/b/me` `/api/c/me` `/api/dbc/me` `/api/admin/import/preview` `/api/admin/queue` 未登录 | 全部 **401** ✅ |
| `/api/growth/leads` `/api/b2b/schools` `/api/b2b/programs` | 全部 **404**（已移除，非隐藏）✅ |
| `/api/public/suppliers` 含 `commission_value` / `contact_phone` / `contact_whatsapp` | **0 处** ✅ |
| `/api/s/finance/me` | **403 `FINANCE_DISABLED`**（功能默认关闭）✅ |
| `/admin` 未登录 | 只显示登录面板，无数据 ✅ |

## 4. 四条核心 E2E（线上执行，38/38 通过）

### 流程一：C 全链路（24 项 ✅）
```
C 自主注册(201) → 待绑定(unbound)
→ 提交需求(201) → 推荐 tier=LEVEL_2
→ C 选 B → 绑定申请(pending_b_request)
→ B 接受 → 生成 B-C 合同
→ C 电子签 → pending_b_signature
→ B 电子签 → 合同 active，C 绑定 active
→ 建申请(S0，11 阶段齐全)
→ 待办闸验证 → 顺序推进 S1→S10（每步 200）
→ C 上传材料（OCR sandbox=true）
→ B 确认 → S 确认（s_confirmed）
→ AETHEL X Sandbox 支付（succeeded，receipt.sandbox=true）
→ Commission Trigger 入账
→ 佣金归属 = 绑定 B ✅
→ C 支付列表不含 net_to_b ✅
```

### 流程二：住宿（6 项 ✅）
```
住宿 S 登录 → 建房（double，可用床位=2）
→ 预订（reserved）→ 入住（可用=1，不为负）
→ 退宿（可用=2，正确释放）
→ 住宿佣金规则可见（FIXED_PER_BOOKING 演示标注）
```

### 流程三：State A（3 项 ✅）
```
DBC 建 DBC-S 协议（state=A）→ DBC 协议列表全部 state=A
→ DBC 可见状态 A 申请
```

### 流程四：State B 隔离（4 项 ✅）
```
平台记录 B_S 状态 B 协议（201）
→ DBC 协议列表无任何 state=B ✅
→ DBC 供应商视图限定状态 A ✅
→ 状态 B 仅平台/当事方可见 ✅
```

## 5. 自动化测试（本地）

`npm test` → **282 passed, 0 failed**（7 个测试文件）。CI Node 18 / Node 20 双矩阵，步骤见 `FULL_MVP_TEST_REPORT.md`。

## 6. Demo 账号线上验证

`POST /api/auth/demo-login {"token":"demo-student-01"}` → 201，token 长度 36，`/api/auth/me` 返回 C 档案 + 能力矩阵（can_order=false 直至绑定）。九个端账号清单见 `FULL_MVP_CLIENT_LINKS.md`。

## 7. 回滚预案

- 代码：`git revert <sha> && git push origin global-study-mvp` → Render 自动重部署（约 3–5 分钟）。
- 数据：`/var/data/aethel.json` 在持久盘，回滚不丢数据；如需回档，先 `GET` 导出关键集合再操作。
- 功能级回滚：全部策略走 `system_config`（如 `ads_enabled`、`finance_enabled`），`POST /api/admin/config/reset` 可即时恢复默认。

## 8. 未纳入本轮（合规边界）

正式贷款/真实支付/保险/自动催收/复杂 FX/正式金融风控 —— 等待下一轮产品验收后另行评估。
