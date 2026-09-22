# CHANGELOG

## V0.5.0 — 全球学校搜索数据底座（2026-09-22）
### Added
- 项目结构按规格拆分：`data/reference/`（locations、curricula、languages、education-stages）+ `data/demo/`（schools、programs、scholarships）。
- 参考字典：2 国家（SG/CN）、3 城市、上海 16 + 北京 16 + 新加坡 5 区域 45 规划区；28 条地铁/轻轨/机场线路、118 个站点/机场/火车站（部分种子，验证结构用）；10 教育阶段；12 课程族 50 课程；15 语言；8 类学校类型。
- 20 条演示学校（Institution + Campus），全 `is_demo` + `verified_status=demo` + `source_url=null`，覆盖新加坡/上海/北京。
- 40 条演示 Program、13 条演示 Scholarship，外键关联 institution。
- 搜索 API `GET /api/schools`：支持 q/country/city/district/stage/curriculum/language/institutionType/minFee/maxFee/scholarship/boarding/transitStation/transitNear/verifiedOnly/sort/page/pageSize，返回 meta 分页，非法参数不崩溃。
- 详情 API `GET /api/schools/:id`：聚合 campuses/programs/scholarships/来源溯源；404 JSON。
- `GET /api/programs`：institution/stage/curriculum/language/minFee/maxFee/q 筛选 + 分页。
- 手机 H5：API 驱动搜索首页（国家/城市/阶段/课程/关键词 + 快捷筛选 chips）、结果页（详情/对比/收藏按钮）、高级筛选 Bottom Sheet（由 `/api/reference` 动态生成）、学校详情页（校区/课程/奖学金/来源）。
- 23 个 smoke 测试，`npm test` 23/23 通过。
- 四份验收报告：V0.5_IMPLEMENTATION_REPORT / TEST_REPORT / DATA_DICTIONARY / CHANGELOG。

### Changed
- 数据字段由 camelCase 统一为 snake_case，对齐 `V0.5_SPEC.md` 实体模型。
- 前端搜索由「前端内存过滤」改为「`/api/schools` API 驱动 + 分页」。
- README 标记 V0.5 完成，列出下一步 V1.0。

### Removed
- 删除与产品无关的遗留文件 `mvp-server.js`、`mvp-server-v2.js`、`data/reference.json`、`data/schools.demo.json`（未被部署引用）。

### Fixed
- 测试 `GET /api/programs` 的 maxFee 阈值（15000 → 20000），与 demo 数据最低学费（16000 SGD）对齐；筛选逻辑本身正确。

## V0.4.0（历史）
- AI Action Mini 商户流水分析 demo（已剥离）。

## V0.5 之前
- 手机 H5 MVP：C/B/S/Admin 四端业务流（申请/客户/受理/审核/结算）。
