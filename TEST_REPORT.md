# TEST_REPORT — V0.5 自动验收与浏览器验收记录

> 执行时间：2026-09-22
> 命令：`npm install` → `npm test`
> 运行环境：Node.js（engines >= 18），本机 Node 24

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

## 浏览器交互验收（IAB 自动化，本地服务，375×800）

| 交互 | 结果 |
| --- | --- |
| 学生端首页渲染 | 通过：hero CTA「开始找学校」、中文区名、地铁站（第六大道（DT））、演示徽标 |
| 找学校页 | 通过：20 所 · 第 1 页，10 张卡片，9 个快捷 chip |
| 快捷筛选 IB | 通过：20 → 4 所（全为 IB 学校）；再点取消恢复 20 |
| 快捷筛选 有住宿 | 通过：20 → 7 所 |
| 快捷筛选 学费较低 | 通过：首卡为全库最低学费 SGD 16,000–26,000 |
| 城市下拉 | 通过：CN-SHA → 6 所 |
| 关键词 | 通过：「蒙」→ 1 所；清空恢复 |
| 高级筛选 Bottom Sheet | 通过：区域 78 选项（按城市分组）、课程 54 项（按课程族分组）、语言 16、类型 9，全部由 /api/reference 动态生成 |
| 学校详情 | 通过：校区、课程/项目、奖学金、数据来源四块齐全 |
| 对比 | 通过：localStorage gs-compares 写入，标题「学校对比（1/4）」，上限 4 所 |
| 收藏 | 通过：localStorage gs-favs 写入 |
| 角色切换 | 通过：agency / supplier / admin / student 四端导航与页面渲染正常 |
| 分页 | 通过：上一页/下一页按钮可用 |

## 手机三档宽度布局验收（程序化几何检查）

| 宽度 | 横向溢出 | 卡片宽度 | 操作按钮（3 个） | 底部导航（4 个） |
| --- | --- | --- | --- | --- |
| 375 | 无 | 332 | 95px 等宽不重叠 | 90px 等宽不重叠 |
| 390 | 无 | 347 | 100px 等宽不重叠 | 94px 等宽不重叠 |
| 430 | 无 | 387 | 114px 等宽不重叠 | 104px 等宽不重叠 |

快捷筛选 chip 行在三档宽度下均为容器内横向滚动（设计如此），不溢出文档宽度。
注：IAB 截图通道在验收环境超时（宿主限制），布局结论以 DOM 几何测量为准。

## 修复记录
- 测试阈值：`GET /api/programs` 的 maxFee 用例原写 15000，低于 demo 最低学费 16000 SGD 导致 0 条；阈值改为 20000（对应真实存在的 program），筛选逻辑本身正确。
- 前端 bug 1：下拉框 onchange 未把选中值写回搜索状态 → 改为 `qFieldChanged(key)` 直接写状态。
- 前端 bug 2：`runSearch()` 内的 `syncForm()` 会用空下拉值覆盖快捷筛选状态 → 移除覆盖，syncForm 只同步关键词输入框。
- 前端 bug 3：关键词输入仅 Enter 触发 → 改为 `oninput` 实时搜索。

## 未覆盖（已知缺口，留待后续）
- 无 375/390/430px 真机（真设备）截图复核（已做程序化几何验收；IAB 截图通道超时）。
- 未引入 e2e 框架（当前浏览器验收为一次性 IAB 自动化）。
- 未接入 CI 配置文件（建议 V1.0 前补 GitHub Actions 跑 `npm test`）。
