# CURRENT_STATE — V0.5 改造前基线（2026-09-21）

> 本文件在动手改代码之前编写，作为本次 V0.5 执行的现状快照与风险评估基线。
> 改造完成后的状态以 V0.5_IMPLEMENTATION_REPORT.md 为准。

## 1. 当前文件结构

```text
stackryze-deploy/            （分支 global-study-mvp）
├── server.js                唯一运行入口（npm start → node server.js）
├── mvp-server.js            历史遗留：商户流水分析 demo（与本产品无关，未被 render.yaml/npm start 引用）
├── mvp-server-v2.js         同上，遗留文件
├── render.yaml              Render Blueprint（buildCommand "No dependencies"，startCommand npm start，healthCheck /api/health）
├── package.json             仅依赖 express ^4.21.2；scripts: start / test
├── data/
│   ├── reference.json       单文件参考字典（阶段/语言/课程族/地区三城）
│   └── schools.demo.json    20 条演示学校（camelCase 字段）
├── public/
│   └── index.html           全部前端逻辑（单文件 SPA，内联 CSS/JS）
├── tests/
│   └── smoke.test.js        纯函数级断言（require server.js 后直接调用 listSchools，无 HTTP）
└── docs/
    ├── ROADMAP.md
    └── V0.5_SPEC.md
```

与任务书目标结构的差距：data 未按 reference/（locations、curricula、languages、education-stages）与 demo/（schools、programs、scholarships）拆分；缺少 Campus / Program / Scholarship 实体数据；缺少地铁线路/站点、机场/火车站参考数据。

## 2. 当前 API

| 端点 | 现状 |
| --- | --- |
| GET /api/health | ok，返回 version 0.5.0、demoSchools 数量 |
| GET /api/reference | 返回 reference.json 原文（version、educationStages、languages、curriculumFamilies、locations） |
| GET /api/bootstrap | 应用演示数据（profile/programs/clients/applications/audits）+ reference + schools，前端唯一数据入口 |
| GET /api/schools | 支持 q/country/city/district/stage/curriculum/language/institutionType/minFee/maxFee/scholarship/boarding/verifiedOnly + 分页；返回 meta.total/page/pageSize；模糊匹配大小写不敏感 |
| GET /api/schools/:id | 命中返回学校原文，未命中 404 JSON |
| GET /api/programs | 服务的是“申请演示”的 3 个 program（school/program/degree/fee），不是 V0.5_SPEC 定义的 Program 实体；无 stage/curriculum/fee/language 筛选 |
| POST/PATCH /api/applications、POST /api/clients、PATCH /api/audits/:id、POST /api/reset | C/B/S/Admin 四端业务演示流，基于内存 db |

字段命名：数据与 API 均为 camelCase（isDemo、verifiedStatus、sourceUrl、updatedAt），与 V0.5_SPEC 的实体模型（snake_case：is_demo、verified_status、source_url 等）不一致。

## 3. 当前前端功能

- 单文件 H5（public/index.html），角色切换：student / agency / supplier / admin（localStorage 记忆）。
- student 首页 hero CTA“开始找学校”→ programs 页；programs 页有 q/country/city/stage/curriculum/maxFee 六个控件，但在前端内存里过滤（未调用 /api/schools）。
- 学校卡片：名称、国家/城市/区、阶段与课程 chips、语言、住宿/奖助、学费区间、交通、演示/已验证徽标；按钮只有“详情 / 收藏”，无“对比”。
- 详情用客户端数据弹 Bottom Sheet，未走 /api/schools/:id。
- 收藏：localStorage（gs-favs），无对比。
- 无高级筛选 Bottom Sheet；筛选项部分硬编码在前端。
- B/S/Admin：客户 CRM、申请管理、院校受理、审核中心、结算/推广总览，全部依赖 /api/bootstrap。

## 4. 当前技术债

1. 数据文件未拆分，字段命名与规格不一致（camelCase vs 规格 snake_case）。
2. 缺少 Campus / Program / Scholarship 实体，无法支撑详情页与后续真实数据导入。
3. 缺少地铁/机场/火车站参考数据，无 transitStation 筛选与“靠近公共交通”结构。
4. /api/programs 与规格脱节；申请演示数据（db.programs）与课程目录概念混用。
5. 前端搜索是内存过滤，不是 API 驱动；高级筛选缺失。
6. 测试仅函数级，未覆盖 HTTP 状态码、404、非法参数、应用启动 smoke。
7. mvp-server.js / mvp-server-v2.js 为无关遗留文件；render.yaml 服务名 ai-action-mini 与产品无关（不影响部署，保留不动）。
8. reference 中 Singapore 用英文区名、无 zh 名；district 无稳定 id，学校与字典无外键关联。

## 5. 可能破坏线上 H5 的风险点

- 线上预览由 Render 从 global-study-mvp 自动部署：任何推送都会直接生效，必须在本地全量验证后再 push。
- /api/bootstrap 是前端唯一聚合入口：改造时必须保留 profile/programs/clients/applications/audits 结构，否则 B/S/Admin 四端全部白屏。
- 前端大量内联 JS 直接读 x.isDemo/x.tuitionMin 等 camelCase 字段：数据字段改 snake_case 必须同步改前端所有取值点，并回归四端页面。
- app.get('*') 兜底返回 index.html：静态资源与 API 路由顺序不能动。
- tests/smoke.test.js 依赖 require('../server') 副作用为空（不监听端口）：改造后测试若自启端口需在退出前关闭，避免挂住 CI。
- 学费“较低”等筛选若写死数值，会因 SGD/CNY 混币种失真：应通过 API 排序参数实现。

## 6. 结论

后端搜索 API 骨架、20 条演示学校、三城地区与课程字典已具雏形；主要缺口是数据模型规格化（拆文件 + snake_case + 四实体）、地铁/机场字典、API 驱动的搜索首页/高级筛选/对比、HTTP 级测试与四份验收报告。按任务书 Task 1→8 顺序执行。
