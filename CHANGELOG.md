# CHANGELOG

## V1.0.0 — 搜索体验 / 详情对比 / 真实数据导入与审核（2026-09-23）
### Added
- 学校详情页（H5 独立页面 + `#/school/:id` hash 路由）：基础资料、学费与首年总成本、奖学金、住宿、Program 列表、数据来源与审核状态。
- 最多 4 所对比：`GET /api/compare?ids=...`（服务端聚合，上限 4）+ H5 对比页横向滚动与差异高亮。
- 收藏与提醒：学校/课程收藏、奖学金截止与开学/申请截止提醒（localStorage，本机保存）。
- 地图数据接口 `GET /api/map/:id`：返回结构化中心坐标与按距离排序的临近站点（支持 `maxStations`/`within`）。`tile_provider` 保持 `null`——V1.0 未接入地图瓦片，前端展示占位与说明而非伪造地图。
- 距离/通勤字段：`distance_m`（haversine 直线距离）、`distance_label`；`commute_label` 恒为 `null`，前端显示「暂无可靠通勤数据」，不编造通勤时间。
- 全部 142 个站点补齐经纬度（`scripts/migrate-v1.js`），20 所演示学校已可计算到站距离。
- 真实数据导入工具：CSV/JSON 解析、字段归一化、字典匹配、校验、重复检测；`POST /api/admin/import/preview` 与 `/api/admin/import/commit`（仅 admin）。
- 来源与有效期机制：`source_url` / `supplier_evidence` / `verified_status` / `verified_at` / `effective_from` / `effective_to`。无来源的数据**不得**标记 verified，导入时强制降级为 draft。
- 后台数据审核队列：`GET /api/admin/queue`、`POST /api/admin/queue/:schoolId/action`（submit / approve / reject / request-info / expire）、`GET /api/admin/schools/:id/revisions`。状态机 draft → pending → verified → expired / rejected，非法流转拒绝。
- 敏感字段（学费/奖学金等）变更强制回退到 pending 重新审核；draft/pending 学校不出现在 C 端搜索。
- B 端学校搜索视图 `GET /api/b2b/schools` 与 `/api/b2b/schools/:id`（需 `x-role: agency|admin`）。
- B 端佣金字段展示：佣金**仅**来自 `is_demo=false` 的真实协议；演示协议只显示「该记录为演示数据，无真实佣金信息」，不泄露任何佣金数值。
- 20 个 V1.0 测试（`tests/v1.test.js`），并入 `npm test`。

### Changed
- `npm test` 现依次运行 V0.5 smoke（23 项）与 V1.0（20 项）。
- 导入记录补齐 `name_zh` / `name_en`，与演示数据同构，保证 C 端搜索可命中。
- 城市解析改为先在已解析国家范围内匹配，避免「Singapore, Singapore」误匹配到国家字典而得到错误 `city_id`。

### Fixed
- `haversineMeters` 对 `null` / 空字符串坐标错误地按 0 处理，返回虚假距离 157km；现正确返回 `null`。
- `parseInput` 对不可解析文本返回 `[]`（假装成功解析）；现返回 `null` 并在预览接口报 400。
- 重复行同时计入 `invalid` 与 `duplicates`，导致三个计数之和不等于 `total`；现重复单独计数。

### Removed
- 无。

## V0.5.0 — 全球学校搜索数据底座（2026-09-22）
### Added
- 项目结构按规格拆分：`data/reference/`（locations、curricula、languages、education-stages）+ `data/demo/`（schools、programs、scholarships）。
- 参考字典：2 国家（SG/CN）、3 城市、上海 16 + 北京 16 + 新加坡 5 区域 45 规划区；28 条地铁/轻轨/机场线路、142 个站点/机场/火车站（新加坡 63 + 上海 34 + 北京 45）（部分种子，验证结构用）；10 教育阶段；12 课程族 53 课程；15 语言；8 类学校类型。
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
