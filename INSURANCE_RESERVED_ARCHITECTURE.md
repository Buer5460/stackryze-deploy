# 保险（S-end）预留架构说明（Insurance Reserved Architecture）

V1.1 **不实现**任何保险业务能力（产品、核保、理赔、接入）。本文件记录为未来 S-end（保险/增值服务）预留的架构占位，确保后续可平滑扩展而不破坏现有增长获客中心。

## 1. 现状（V1.1）
- Feature flag：`insurance_enabled = false`（关闭）。
- 预留模型：`Provider`（id `insurance-reserved`，`provider_type='insurance'`，`integration_mode='manual'`，`integration_status='reserved'`）。
- 预留字段：`service_products: []`、`integration_configs: []`。
- 接口：
  - `GET /api/growth/insurance`（增长团队可读，用于内部规划占位）。
  - `GET /api/growth/insurance/enabled`（无角色门禁，供前端判断是否展示保险商店；当前返回 `false`）。

## 2. 预留的数据模型（Provider + ServiceProduct + IntegrationConfig）
```
insurance = {
  version,
  feature_flag: { insurance_enabled: false },
  providers: [
    {
      id, provider_type: 'insurance',
      integration_mode: 'manual' | 'api',     // 预留：手动录入 or API 对接
      integration_status: 'reserved' | 'active',
      note
    }
  ],
  service_products: [ /* 预留：保险/增值服务 SKU */ ],
  integration_configs: [ /* 预留：密钥/回调/费率表等接入配置 */ ]
}
```

## 3. 未来接入路径（不为本阶段实现）
1. 打开 `insurance_enabled`（通过后台配置或环境变量），前端据 `/enabled` 展示保险商店入口。
2. 通过 `providers` 注册保险供应商；`integration_mode='api'` 时填写 `integration_configs`（密钥、webhook、产品目录拉取）。
3. `service_products` 挂载具体险种/增值服务 SKU，关联院校/课程/学生池。
4. 核保/理赔作为独立服务模块（建议位于 `lib/insurance.js` + `/api/insurance/*`），与增长获客中心解耦，仅共享「组织/B 账户」主体。
5. 佣金/分成走既有结算（`settlement`）台账，不新建支付链路（MVP 不真实扣款）。

## 4. 约束（红线）
- 本阶段**禁止**开发：保险 API 对接、核保、理赔、自动扣费。
- 与贷款、住宿交易、复杂支付一样，列为 V1.5 及以后范围。
- 所有保险事实同样遵循来源校验红线（不编造承保/理赔数据）。

## 5. 验证（当前）
- 测试 `Insurance: feature flag disabled (false); provider reserved model present` 通过：`insurance_enabled=false`、`provider_type=insurance`、`integration_mode=manual`、`integration_status=reserved` 均存在。
