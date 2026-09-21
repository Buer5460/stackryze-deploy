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
V0.5 开发中。

已完成：
- C / B / S / Admin 四端手机 H5 入口
- Node.js + Express API
- Render 公网部署
- 新加坡 / 上海 / 北京参考地区字典
- 教育阶段与国际课程体系字典
- 20 条明确标记为 Demo 的学校数据
- /api/reference
- /api/schools
- /api/schools/:id
- /api/programs
- 手机 H5 学校搜索：国家 / 城市 / 阶段 / 课程 / 最高学费
- 收藏使用 localStorage
- V0.5 smoke tests

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
V0.5：
- 完成高级筛选 Bottom Sheet
- 完成地区/地铁字典导入
- 完成学校数据后台审核结构
- 把演示搜索改为 API 驱动
- 加入 CI 自动执行 npm test

完成后进入 V1.0：学校详情、4校对比、收藏/提醒、地图和真实学校数据导入。
