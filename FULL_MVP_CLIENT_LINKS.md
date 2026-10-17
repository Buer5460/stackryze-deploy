# FULL MVP V3 — 客户端链接清单

**版本**：3.0.0 ｜ **部署**：Render `global-study-mobile-mvp` ｜ **日期**：2026-10-17

基地址：**https://global-study-mobile-mvp.onrender.com**

---

## 1. 公网客户端 URL

| # | 客户端 | URL | 角色 | 登录要求 |
| --- | --- | --- | --- | --- |
| 1 | 客户端选择器 | [/](https://global-study-mobile-mvp.onrender.com/) | 全部 | 无 |
| 2 | 学生 / 家长端 | [/student](https://global-study-mobile-mvp.onrender.com/student) | C | Demo 一键 / 注册 |
| 3 | 留学机构端 | [/agent](https://global-study-mobile-mvp.onrender.com/agent) | B | Demo 一键 / 注册 |
| 4 | DBC 招生牌照 | [/dbc](https://global-study-mobile-mvp.onrender.com/dbc) | DBC | Demo 一键 |
| 5 | 教育机构 | [/supplier/education](https://global-study-mobile-mvp.onrender.com/supplier/education) | S-EDUCATION | Demo 一键 |
| 6 | 体检机构 | [/supplier/medical](https://global-study-mobile-mvp.onrender.com/supplier/medical) | S-MEDICAL | Demo 一键 |
| 7 | 文件认证 | [/supplier/certification](https://global-study-mobile-mvp.onrender.com/supplier/certification) | S-CERTIFICATION | Demo 一键 |
| 8 | 签证代办 | [/supplier/visa](https://global-study-mobile-mvp.onrender.com/supplier/visa) | S-VISA | Demo 一键 |
| 9 | 学生住宿 | [/supplier/accommodation](https://global-study-mobile-mvp.onrender.com/supplier/accommodation) | S-ACCOMMODATION | Demo 一键 |
| 10 | 教育金融 | [/supplier/finance](https://global-study-mobile-mvp.onrender.com/supplier/finance) | S-FINANCE | 无（功能默认关闭） |
| 11 | 广告中心 | [/ads](https://global-study-mobile-mvp.onrender.com/ads) | B / S | Demo 一键 |
| 12 | 院校 / 供应商入口 | [/institution](https://global-study-mobile-mvp.onrender.com/institution) | S | 无 |
| 13 | 平台管理端 | [/admin](https://global-study-mobile-mvp.onrender.com/admin) | ADMIN | **必须登录** |

`.html` 旧别名（`/student.html` 等）同时保留并指向相同客户端，旧链接不会 404。

**Admin 不出现在公网导航**：客户端选择器上 Admin 卡片仅作为入口提示"需登录"；未登录访问 `/admin` 只显示登录面板，全部 `/api/admin/*` 返回 401。

---

## 2. 演示账号（一键体验）

登录方式：任一客户端登录面板点击对应"一键体验 Demo"按钮，或

```bash
curl -X POST https://global-study-mobile-mvp.onrender.com/api/auth/demo-login \
  -H 'Content-Type: application/json' -d '{"token":"<TOKEN>"}'
```

| 端 | Token | 角色 | 进入 |
| --- | --- | --- | --- |
| C 学生 | `demo-student-01` | C_STUDENT 陈小雨 | /student |
| B 机构 | `demo-agent-01` | B_OWNER 王老师（环球学桥 Level 2） | /agent |
| S 教育 | `demo-supplier-education-01` | S_OWNER 南洋国际学院 | /supplier/education |
| S 体检 | `demo-supplier-medical-01` | S_OWNER 康桥体检中心 | /supplier/medical |
| S 认证 | `demo-supplier-certification-01` | S_OWNER 正衡文件认证 | /supplier/certification |
| S 签证 | `demo-supplier-visa-01` | S_OWNER 通行签证代办 | /supplier/visa |
| S 住宿 | `demo-supplier-accommodation-01` | S_OWNER 安寓学生住宿 | /supplier/accommodation |
| DBC | `demo-dbc-01` | DBC_OWNER 安途招生牌照 | /dbc |
| Admin | `demo-admin-01` | ADMIN_SUPER 平台管理员 | /admin |

真实注册入口同时开放（`POST /api/auth/register`），自注册的 C 一律从"待绑定"开始（规则 2）。

---

## 3. 演示数据说明

- 3 家 B：环球学桥（Level 2，合格）、启航留学（Level 1，合格）、新锐国际教育（Free + 未认证，**用于演示准入拒绝**）、远帆留学（Level 2，验证同层轮换）。
- 6 类 S 供应商全部 `is_demo: true` 且公开可见，演示佣金规则标注"不代表真实商业条款"。
- 20 所演示学校 + 40 课程 + 13 奖学金（沿用 V0.5/V1.0 数据）。
- 广告位库存 4 类（搜索赞助 / 横幅 / 推荐位 / 开屏），价格取自可配置演示默认值。

---

## 4. 健康检查

- `GET [/api/health](https://global-study-mobile-mvp.onrender.com/api/health)` → `{"ok":true,"version":"3.0.0",...}`，含 `backend` / `persistence` 如实上报。
- `GET /api/meta` → 客户端清单、数据政策、支付适配器目录。
