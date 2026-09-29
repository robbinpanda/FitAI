# 北京 ECS 当前状态（2026-09-29）

已按所有者要求启用公网 IP HTTPS 访问：**https://8.152.196.106/**。无需 SSH 隧道。阿里云安全组 80/443 已由用户放行，UFW 同步开放。`fitai` 仍只监听 `127.0.0.1:8765`，由 Nginx 对外提供 443；80 仅提供 ACME 验证及跳转 HTTPS。应用配置为 `FITAI_SSH_PREVIEW=0`、`FITAI_PUBLIC_ORIGIN=https://8.152.196.106`，原 localhost 隧道来源不再接受。

公网 IP 的 Let's Encrypt 证书已签发并通过电脑端严格 TLS 校验（IP SAN 匹配，TLS 1.3）。首张证书到期时间为 2026-10-05 22:50:36 UTC。Certbot 5.4 位于 `/opt/fitai-certbot`，`fitai-certbot.timer` 每天检查两次，成功续期后验证并 reload Nginx；旧系统 `certbot.timer` 已停用，避免旧版工具处理 IP 证书。续期演练（dry-run）已成功，Nginx reload hook 也已执行。保留 80 端口和 ACME 路径以便续期。

已从公网验证：首页、健康和登录状态接口 200，匿名个人记录接口 401；浏览器成功打开主页，没有忽略证书错误。邀请码、共享模型配置、账号隔离和限流保持有效。内存软限制 900 MiB、硬上限 1200 MiB。

IP 访问不替代北京节点的备案要求，阿里云仍可能拦截未备案网站。域名 `jianjianfei.top` 尚未切换上线。切换前环境备份为 `/var/backups/fitai/before-public-ip.env`（600）。IP Nginx 配置源文件为 `deploy/ip.nginx.conf`，服务器启用 `/etc/nginx/sites-available/fitai-ip`。

以下为历史部署记录，其中旧访问方式以本节当前状态为准。

## 初始部署记录

SSH 别名：`fitai-server`。系统 Ubuntu 24.04.5 LTS，2 vCPU，系统可见内存约 1740 MiB，40 GB 磁盘。

## 当前访问方式

应用已安装并运行，仅提供 **SSH 私人预览**，没有公网 Web 监听。域名为 `jianjianfei.top`，用户确认正在办理备案，继续使用北京节点。

- 代码 `/opt/fitai`，root 所有，网站进程不可改写。
- 数据 `/var/lib/fitai`，fitai 所有，目录权限 700；账号数据库权限 600。
- 配置 `/etc/fitai.env`，root:root 600。
- 服务 `fitai.service`，普通用户运行，已启用开机启动；实际监听 `127.0.0.1:8765`。
- `FITAI_MODE=server`，`FITAI_SSH_PREVIEW=1`，来源 `http://localhost:18765`；邀请码、认证和出站地址限制都保留。
- 资源覆盖配置 `/etc/systemd/system/fitai.service.d/resources.conf`：MemoryHigh 900 MiB，MemoryMax 1200 MiB。用户不再使用远端 VS Code 后，已停止其后台进程并在线提高限制，无需重启应用；调整后系统可用内存约 1323 MiB。首次安装脚本仍采用更保守的 512/768 MiB，方便与远端开发工具共存。
- Nginx 与 Certbot 已安装，Nginx 暂时 masked，防止意外公开默认站点。
- UFW 已启用，默认拒绝入站，目前只有 `22/tcp LIMIT`（IPv4/IPv6）；新 SSH 连接已验证。原 SSH 密码和键盘交互认证已经关闭，密钥认证可用。
- 已按所有者指定值开启邀请注册，设置时可用名额为 5；仅存储加盐哈希，不在文档记录邀请码。注册状态接口已验证开放，没有为验证创建生产账号。

## 你现在可以做的两步

在 VS Code 的服务器终端设置邀请码：

```bash
sudo -u fitai /opt/fitai/.venv/bin/python /opt/fitai/manage.py invite --data-dir /var/lib/fitai --uses 5
```

输入自己选择的至少 16 字符邀请码两次（不回显）。随后在电脑 PowerShell 建立隧道，并保持窗口打开：

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18765:127.0.0.1:8765 fitai-server
```

使用 Chrome 或 Edge 打开 **http://localhost:18765**，刷新后注册账号。不要把 localhost 换成公网 IP。账号记录保存在 ECS；电脑到 ECS 的网络传输由 SSH 加密。验证用隧道会在本次工作结束前关闭，不是常驻系统服务。

## 实机验证

- 96 项 Python 测试：95 通过、1 个 Windows batch 测试在 Ubuntu 跳过；全部使用临时数据。日志 `/tmp/fitai-validation-20260929.log`。
- 生产服务健康接口成功；匿名业务接口受到账号保护，注册状态为关闭。
- 浏览器通过 SSH 隧道成功打开服务器邀请注册页面。
- `systemd-analyze verify` 通过；服务以 fitai 用户运行。
- 实测空闲 cgroup 内存约 29 MB，启动峰值约 47 MB（约 45 MiB）；不是多人图片/长对话压测结果。
- 首次备份 `/var/backups/fitai/fitai-20260929-122136.tar.gz`。离线解压到临时目录后 SQLite integrity_check 通过，没有覆盖生产数据。
- 用一次性临时证书执行 Nginx 模板语法检查通过；这不是正式域名证书，不启动任何公网监听。
- Waitress 3.0.2 已通过官方 PyPI HTTPS 下载重装，不使用镜像预设的 HTTP pip 源。

## 正式上线前

已生成 `deploy/jianjianfei.top.nginx.conf` 并上传至服务器 `/etc/nginx/sites-available/fitai`，代理片段已上传；站点尚未启用，没有签发正式证书。2026-09-29 查询阿里云公共 DNS：域名使用 dns13.hichina.com / dns14.hichina.com，目前没有 A / AAAA 记录。

备案通过后，在阿里云云解析 DNS 添加 A 记录：主机记录 `@`，记录值 `8.152.196.106`，TTL 默认。当前配置仅包含主域名，不包含 `www`。首次备案期间先保持私人预览；阿里云说明未取得备案号前不能对外开通 Web 服务，参见 https://help.aliyun.com/zh/icp-filing/the-influence-of-the-record-during-the-site-visit 。

正式启用时关闭 SSH 预览开关，将真实来源设为 `https://jianjianfei.top`，申请证书，禁用默认站点、启用 渐渐飞 配置并验证后取消 Nginx 的 mask；同时按需开放 UFW 与阿里云安全组的 80/443。北京节点应在满足备案要求后公开网站。

后续仍需真实模型连通/额度验证、小规模实际使用负载观察，以及独立位置的加密备份。不要把当前空闲内存当成满载容量承诺。


## 共享模型与联网搜索（2026-09-29）

已由所有者授权，从本机旧配置中仅提取 DeepSeek 和 Tavily 配置，经 SSH 传入 `/etc/fitai-shared.env`（root:root 600）；服务通过 `shared-api.conf` 加载。默认模型为 deepseek-flash。未复制本地健康记录、对话或账号数据。用户 Key 优先，删除后恢复共享默认值，搜索开关保持用户选择。共享密钥不出现在设置响应中，也不写入个人数据库。

升级前备份：`/var/backups/fitai/fitai-20260929-152950.tar.gz`，旧版三个代码文件位于 `/var/backups/fitai/code-before-shared-api/`。更新后应用健康接口 200；服务器 17 项账号测试全部通过，覆盖默认配置、个人覆盖、删除回退、账号隔离和共享密钥地址限制；DeepSeek 最小请求成功，Tavily 返回 8 条结果。这两次连通验证消耗少量真实 API 额度。


## 功能展示主页（2026-09-29）

根路径 `/` 现为渐渐飞功能展示主页，包含餐食营养估算示意、聊天记录流程、可切换 14/30 天的体重趋势示例。右上角登录和注册进入 `/auth.html` 与 `/auth.html?mode=register`，成功后跳转 `/index.html` 进入原应用。主页展示不请求个人记录、不调用模型；业务接口继续要求登录。

已在桌面与手机尺寸检查无横向溢出，验证营养与趋势切换、注册入口和临时测试账号登录跳转。ECS 首页与静态资源返回 200，匿名 `/api/state` 返回 401，健康接口 200。代码回退包：`/var/backups/fitai/code-before-landing-20260929.tar.gz`。仍通过原 SSH 私人预览访问，没有开放公网端口。
