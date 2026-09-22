# GlobalStudy Mobile MVP

全球学校搜索与教育服务交易平台的手机 H5 + Node.js/Express MVP。

## 当前定位
不是单纯的“留学申请小程序”，而是分阶段演进为：
1. 全球学校搜索与筛选
2. Search → Apply 申请协同
3. S2B2C 代理/佣金/结算
4. 学生住宿与教育服务 Marketplace
5. 合规前提下的教育金融转介/服务

## 当前版本
**V0.5.0 — 数据底座与搜索引擎（已完成）**

已完成：
- C / B / S / Admin 四端手机 H5 入口
- Node.js + Express API
- Render 公网部署
- 数据按规格拆分：reference（locations / curricula / languages / education-stages）+ demo（schools / programs / scholarships）
- 新加坡 / 上海（16 区）/ 北京（16 区）参考地区字典 + 地铁线路/站点结构位
- 教育阶段（10）与国际课程体系字典（50+）
- 20 条明确标记为 Demo 的学校数据（Institution + Campus，覆盖 SG / 上海 / 北京）
- 40 条演示 Program + 演示 Scholarship
- /api/reference
- /api/schools（q/country/city/district/stage/curriculum/language/institutionType/minFee/maxFee/scholarship/boarding/transitStation/transitNear/verifiedOnly/sort + 分页）
- /api/schools/:id（聚合校区/课程/奖学金/来源溯源）
- /api/programs（institution/stage/curriculum/language/fee/q 筛选）
- 手机 H5 学校搜索：API 驱动首页（国家 / 城市 / 阶段 / 课程 / 关键词 + 快捷筛选）+ 结果页（详情/对比/收藏）+ 高级筛选 Bottom Sheet（由 /api/reference 动态生成）
- 收藏 / 对比使用 localStorage（最多 4 所对比）
- V0.5 smoke tests：23 / 23 通过

验收文档：V0.5_IMPLEMENTATION_REPORT.md / TEST_REPORT.md / DATA_DICTIONARY.md / CHANGELOG.md

## 在线地址
https://global-study-mobile-mvp.onrender.com

## 开发分支
global-study-mvp

不要修改 main；本项目的继续开发全部在 global-study-mvp 或其子分支进行。

## 重要文档
- docs/ROADMAP.md
- docs/V0.5_SPEC.md
- WORKBUDDY_V0.5_TO_V1.0.md

## 本地运行

```bash
npm install
npm test
npm start
```

访问：

```text
http://localhost:3000
```

## API

- GET /api/health
- GET /api/reference
- GET /api/bootstrap
- GET /api/schools
- GET /api/schools/:id
- GET /api/programs
- POST /api/applications
- PATCH /api/applications/:id
- POST /api/clients
- PATCH /api/audits/:id
- POST /api/reset

## 数据声明
当前学校均为 Demo 数据，用于验证产品、数据模型、筛选和交互。地区与课程体系参考字典来自用户提供的产品资料，但不等于任何真实学校合作、招生授权或商业关系。

真实学校数据进入系统前必须建立：
- source_url / 供应商证明
- verified_status
- verified_at
- effective_from / effective_to

禁止由 AI 猜测或补全学校事实、佣金协议或录取概率。

## 下一步
V1.0（V0.5 验收完成后启动）：
- 学校详情页地图与距离/通勤字段（基于 transitStation 经纬度）
- 最多 4 所对比（增强差异高亮）
- 收藏 / 提醒（localStorage → 服务端化）
- 真实学校数据导入工具（带 source_url / verified_at / effective dates 校验）
- 后台数据审核队列（verified_status 流转）
- B 端学校搜索视图、佣金字段展示（仅展示有真实协议或后台录入的数据）
- CI 自动执行 npm test
