# TEST_REPORT — V0.5 自动测试

> 执行时间：2026-09-22
> 命令：`npm install` → `npm test`
> 运行环境：Node.js（engines >= 18）

## 结果总览
**23 passed, 0 failed**

测试为纯 Node + Express 进程内 `fetch` 调用，不依赖外部服务，可在 CI 直接执行（`npm test`）。

## 用例清单

| # | 用例 | 类型 | 结果 |
| --- | --- | --- | --- |
| 1 | data integrity：20 条 demo school，全 is_demo + verified_status=demo + source_url=null | 数据 | ok |
| 2 | reference：3 cities；上海 16 + 北京 16 + 新加坡 5 区域 45 规划区 | 字典 | ok |
| 3 | reference：stages 10、curricula 50+、languages 15、transit 已种子 | 字典 | ok |
| 4 | GET /api/health | API | ok |
| 5 | GET /api/reference 返回全部字典 | API | ok |
| 6 | GET /api/schools 基础：无参数返回分页列表 + meta | API | ok |
| 7 | GET /api/schools 分页：page=2&pageSize=5 | API | ok |
| 8 | GET /api/schools 组合：SG + Bukit Timah + primary + IB → SG-DEMO-001 | API | ok |
| 9 | GET /api/schools 组合：中文 free-text country + curriculum 族 | API | ok |
| 10 | GET /api/schools city+stage：上海 primary | API | ok |
| 11 | GET /api/schools 费用：minFee/maxFee + sort=fee_asc | API | ok |
| 12 | GET /api/schools 布尔：scholarship=true / boarding=true | API | ok |
| 13 | GET /api/schools language + institutionType | API | ok |
| 14 | GET /api/schools transitStation：Tampines → SG-DEMO-004 | API | ok |
| 15 | GET /api/schools q 命中名称/课程/站点 | API | ok |
| 16 | GET /api/schools 非法参数不崩溃：垃圾参数 + 未知 stage = 空 200 | API | ok |
| 17 | GET /api/schools/:id 聚合 campuses/programs/scholarships/source | API | ok |
| 18 | GET /api/schools/:id 未知 id → 404 | API | ok |
| 19 | GET /api/programs 筛选：institution / stage / curriculum / maxFee(20000) / q | API | ok |
| 20 | GET /api/bootstrap 保留 C/B/S/Admin 演示 payload | API | ok |
| 21 | POST /api/applications 非法 payload → 400 | API | ok |
| 22 | 未知 /api 路径返回 JSON 404（非 SPA html） | API | ok |
| 23 | app start smoke：GET / 返回含 C/B/S/Admin 角色的 H5 | 启动 | ok |

## 修复记录
- 原 `GET /api/programs` 的 maxFee 阈值测试写为 `maxFee=15000`，但 40 条 demo program 的最低学费为 16000 SGD，导致该用例返回 0 条而失败。已将阈值改为 `20000`（对应 3 条真实存在的 program），验证费用筛选逻辑正确，同时不改动 demo 数据。

## 未覆盖（已知缺口，留待后续）
- 无浏览器端 375/390/430px 真机布局自动断言（当前为代码审查 + 结构审查，未引入 e2e 框架）。
- 无渲染后 H5 交互点击的自动化（依赖 `npm test` 的 HTML 结构断言 + 人工/后续 e2e）。
- 未接入 CI 配置文件（建议在 V1.0 前补 GitHub Actions 跑 `npm test`）。
