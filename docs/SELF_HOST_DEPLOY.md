# GlobalStudy 自有服务器部署

## 部署方式

推荐 Docker Compose：Node 服务、第一方静态前端和 API 由同一容器提供，数据库文件放进 Docker 持久卷。现有 PostgreSQL 后端仍可通过 `DATABASE_URL` 使用。

## 环境要求

- Linux 服务器、Docker Engine 和 Docker Compose 插件。
- 已配置域名和 HTTPS 反向代理。外网只开放 80/443；应用端口默认仅绑定到服务器回环地址。
- 生产数据目录/数据库必须持久保存并定期备份。

## 首次部署

1. 将本目录代码放到服务器，进入项目根目录。
2. 创建环境文件并填入运营主体和隐私联系渠道：

   ```sh
   cp .env.example .env
   ```

3. 创建首位平台管理员。输入密码时终端不回显，需至少 12 位：

   ```sh
   docker compose run --rm --no-deps globalstudy npm run admin:create -- ops@example.com
   ```

4. 构建并启动：

   ```sh
   docker compose up -d --build
   ```

5. 在本机确认服务可访问，再配置 Nginx/Caddy 将域名的 HTTPS 流量代理到 `127.0.0.1:3000`。管理后台入口为 `/admin`。

管理账号使用 `npm run admin:create -- 邮箱` 创建。不要开启 `PUBLIC_ADMIN_DEMO`，也不要使用项目内的演示账号登录生产环境。

## Nginx 反向代理示例

把 `example.com` 替换为自己的域名，并按服务器证书管理方式补全 TLS 配置。此配置覆盖客户端传入的转发头，避免伪造访问 IP：

```nginx
server {
    listen 443 ssl http2;
    server_name example.com;

    # ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

如果应用前有且仅有一个可信反向代理，设置 `ANALYTICS_TRUST_PROXY_HOPS=1`。多层代理按真实可信层数配置；不可直接信任浏览器传来的 `X-Forwarded-For`。不使用代理时设为 `0`。

## 启用访客统计

在 `.env` 填写真实信息后再开启：

```dotenv
ANALYTICS_ENABLED=true
ANALYTICS_CONTROLLER_NAME=运营主体全称
ANALYTICS_PRIVACY_CONTACT=隐私咨询邮箱或可用客服渠道
ANALYTICS_TRUST_PROXY_HOPS=1
ANALYTICS_COOKIE_SECURE=true
```

重建服务使配置生效：

```sh
docker compose up -d --build
```

未填写运营主体或联系渠道时，统计接口会保持关闭。上线前由运营主体确认统计目的、告知内容、处理依据、访问权限和保留期限。IP 与访问行为组合时应按可识别个人信息进行评估；《个人信息保护法》要求事先告知处理者名称和联系方式、处理目的与方式、信息种类及保存期限，并采用实现目的所需的最短保存期限，参见[法律全文](https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm?mxsmoban=zzzq)。具体适用情况请由运营主体结合实际业务确认。

## 贷款与体检模块

默认配置 `GS_DISABLED_MODULES=MEDICAL,FINANCE` 会隐藏并拒绝这两个供应商模块的业务入口。要维持当前版本范围，不要删除该设置。

## 数据与备份

- 默认 JSON 数据路径：Docker 持久卷 `/data/db/aethel.json`。
- 使用 PostgreSQL 时配置 `DATABASE_URL`，并为数据库单独设置备份和恢复流程。
- 备份文件可能包含账号、业务数据、IP 和访客行为；应加密保存并限制访问，不能放入 Git 仓库、公开对象存储或工单附件。
- 运行环境的代理与托管服务可能另有访问日志；需单独设定查看权限和保留期限。

## 常用维护命令

```sh
docker compose logs -f globalstudy
docker compose restart globalstudy
docker compose down
```

`docker compose down` 不会删除命名数据卷。只有明确要清空数据时才执行带 `-v` 的命令。
