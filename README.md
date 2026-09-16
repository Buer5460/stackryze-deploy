# AI Action Mini

一个先在 **iPhone 13** 上跑通的 AI Action Hub MVP。

核心链路：

```text
iPhone Siri / 快捷指令
        ↓
自然语言
        ↓
AI Action Mini API
        ↓
Intent / Universal Action
   ├─ iPhone 本地动作：提醒、日历、备忘、打开网页
   └─ 服务端动作：商户分析、创建跟进任务
```

## 当前已实现

- `reminder.create`：iPhone 创建提醒
- `calendar.create`：iPhone 创建日历
- `note.create`：iPhone 创建备忘录
- `url.open`：iPhone 打开 URL
- `business.query`：服务端查询 50 家 Mock 商户数据
- `followup.create`：服务端创建跟进任务，必须二次确认
- `ai.answer`：配置 OpenAI API Key 后启用通用 AI
- 浏览器调试台
- 简单会话上下文：支持“查询商户 → 给前三家建跟进任务”
- JSONL 审计日志
- API Bearer Token

## iPhone 13

iPhone 13 直接使用 Siri + Shortcuts。第一阶段不需要 Xcode、不需要 Apple Developer Account，也不依赖 Apple Intelligence。

## API

- `GET /api/health`
- `POST /api/v1/command`
- `POST /api/v1/execute`

完整代码和部署配置位于本仓库。