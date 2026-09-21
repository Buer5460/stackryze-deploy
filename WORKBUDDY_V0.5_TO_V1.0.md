# WorkBuddy 执行任务：GlobalStudy V0.5 → V1.0

你正在维护仓库：

- Repo: Buer5460/stackryze-deploy
- Target branch: global-study-mvp
- 不允许修改 main
- 线上预览由 Render 从 global-study-mvp 自动部署

## 一、目标
把现有“手机 H5 留学申请 Demo”升级为“全球学校搜索与筛选平台”的正式开发基线。

当前优先级：
1. V0.5 数据底座
2. V1.0 搜索体验

不要提前做贷款、复杂支付、微服务拆分。

---

## 二、先阅读
开始前必须阅读：
- docs/ROADMAP.md
- docs/V0.5_SPEC.md
- README.md
- server.js
- public/index.html

先输出一份 CURRENT_STATE.md：
- 当前文件结构
- 当前 API
- 当前前端功能
- 当前技术债
- 可能破坏线上 H5 的风险

然后再动代码。

---

## 三、V0.5 开发任务

### Task 1：整理项目结构
目标结构建议：

data/
  reference/
    locations.json
    curricula.json
    languages.json
    education-stages.json
  demo/
    schools.json
    programs.json
    scholarships.json

src/ 或 server modules（若不想大改可先保持 server.js，但必须拆分数据文件）

public/
  index.html

docs/
  ROADMAP.md
  V0.5_SPEC.md

tests/

要求：
- 不要一次重构到复杂框架。
- 继续使用 Node.js + Express。
- 保证 Render 可以 npm install + npm start 直接启动。

### Task 2：建立参考字典
根据 docs/V0.5_SPEC.md 建立：
- Singapore 地区层级
- Shanghai 16 districts
- Beijing 16 districts
- education stages
- curriculum families

注意：
- 用户资料中的地区/课程字典可以作为 seed。
- 不要把不存在于资料里的学校信息补成“真实学校”。
- 测试学校一律 is_demo=true。

### Task 3：学校数据模型
新增 Institution / Campus / Program / Scholarship 的 demo JSON。
至少 20 条 demo school records，覆盖：
- Singapore
- Shanghai
- Beijing

每条明确：
- is_demo: true
- verified_status: demo
- source_url: null

### Task 4：搜索 API
必须实现：

GET /api/reference
GET /api/schools
GET /api/schools/:id
GET /api/programs

/api/schools 至少支持：
q
country
city
district
stage
curriculum
language
institutionType
minFee
maxFee
scholarship
boarding

要求：
- 参数可组合
- 无参数返回分页列表
- 返回 meta.total / meta.page / meta.pageSize
- 非法参数不能使服务崩溃

### Task 5：手机 H5 搜索首页
把 C 端首页核心 CTA 调整为“找学校”。

第一屏：
- 国家/城市
- 教育阶段
- 课程体系
- 搜索关键词
- 搜索按钮

快捷筛选：
- 国际学校
- IB
- Cambridge
- 学费较低
- 有奖学金
- 有住宿
- 靠近公共交通（先做结构，距离算法后续）

### Task 6：结果页
每张卡显示：
- 学校名称
- 国家 / 城市 / 区
- 阶段
- 课程
- 语言
- 学费
- 住宿
- 奖学金
- 数据状态：演示 / 已验证
- 更新时间

按钮：
- 查看详情
- 对比
- 收藏

V0.5 对比/收藏可先使用 localStorage。

### Task 7：高级筛选
手机 Bottom Sheet：
- 区域
- 课程
- 语言
- 学费范围
- 学校类型
- 有住宿
- 有奖学金

筛选项必须从 /api/reference 动态生成，不能前端写死。

### Task 8：测试
至少建立：
- /api/health
- /api/reference
- /api/schools basic
- combined filters
- /api/schools/:id 404
- app start smoke test

npm test 必须可执行。

---

## 四、V1.0 开发任务
只有 V0.5 验收完成后再做：

1. 学校详情页
2. 最多 4 所对比
3. 收藏/提醒
4. 地图数据接口
5. 距离/通勤字段
6. 真实数据导入工具
7. source_url / verified_at / effective dates
8. 后台数据审核队列
9. B端学校搜索视图
10. B端佣金字段展示（只展示有真实协议或后台录入的数据）

---

## 五、禁止事项
- 不修改 main
- 不删除现有 C/B/S/Admin 角色切换
- 不把 demo 数据写成真实学校
- 不生成虚构排名、录取率、佣金协议
- 不用 AI 猜学校事实
- 不在 V0.5 接复杂支付
- 不做贷款放款/还款
- 不上 Kubernetes / 微服务

---

## 六、每个任务完成后的自动验收
你必须自己执行：
- npm install
- npm test
- npm start（或等价 smoke test）
- API health check
- 手机宽度 375px / 390px / 430px 基础布局检查
- 确认没有破坏 B/S/Admin 原有入口

有错误自己修，不要求用户手动复测。

---

## 七、最终提交
完成 V0.5 后提交：
- V0.5_IMPLEMENTATION_REPORT.md
- TEST_REPORT.md
- DATA_DICTIONARY.md
- CHANGELOG.md

报告必须明确：
- 做了什么
- 没做什么
- 哪些是 demo 数据
- 下一步 V1.0 做什么
- 当前线上 URL 是否正常

然后等待产品验收，不要自动进入 V1.2。
