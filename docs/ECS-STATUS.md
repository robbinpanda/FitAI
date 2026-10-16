# 北京 ECS 当前状态（2026-10-16）

## 当前域名入口

正式入口为 **https://www.jianjianfei.top/**，**https://jianjianfei.top/** 以 308 跳转到 www，保留路径和查询参数。用户确认 ICP 备案已审核通过。已从 ECS、本机严格 TLS 请求和内置浏览器验证首页可访问，健康接口 200，匿名 `/api/state` 401。HTTP 和原公网 IP 的 HTTPS 均以 308 跳转到 www 域名。

本次故障有三层：阿里云仅配置 `www` A 记录；Nginx 只接受 IP；应用 `FITAI_PUBLIC_ORIGIN` 及证书均为 IP。现已改为 `FITAI_PUBLIC_ORIGIN=https://www.jianjianfei.top`，关闭 SSH 预览，保留账号与请求来源校验。

域名证书 SAN 为 `jianjianfei.top` 和 `www.jianjianfei.top`，有效期至 2027-01-14 UTC，证书名称仍为 `www.jianjianfei.top`；原 IP 证书保留用于跳转。HTTP ACME webroot `/var/lib/fitai-acme` 保留。实际启用链接仍为 `/etc/nginx/sites-enabled/fitai-ip`，对应配置已同步到 `deploy/www.jianjianfei.top.nginx.conf`；此文件是替换当前站点的完整配置，不能与旧模板同时启用（包含相同限流区和默认站点）。

本机网络会返回代理合成的 198.18.* DNS 地址，不能据此判断公网解析错误。已从 ECS 查询阿里 DNS 与权威 DNS，确认 `www.jianjianfei.top` 和根域名均指向 `8.152.196.106`。用户补充 `@` 记录后，已扩展域名证书 SAN 并加入根域名 HTTPS 跳转站点；本机实测 `/auth.html?mode=register` 路径及参数完整保留，根域名跟随跳转首页最终 200。

续期超时排查：相同服务器对正式和 staging ACME 的普通 requests、默认 ALPN、不带 ALPN、TLS 1.2、urllib 及 ACME ClientNetwork 探测均曾成功；对真实失败的追踪确认包括 TLS 握手超时和握手完成后的读取超时。此前判断为固定 ALPN 兼容问题证据不足，已移除临时 `certbot-compatible.py` 和对应 systemd override，保留标准 TLS 协商及证书/主机名校验。

新的 `deploy/certbot-network.py` 为 ACME 客户端配置有界网络重试：最多重试 3 次，读取超时及 429/5xx 响应仅对 GET/HEAD 重试；签名 POST 不会因读取超时或 HTTP 错误响应被重放。`fitai-certbot.timer` 每天两次检查全部证书，定时器已有最多 1 小时随机延迟，Certbot 内部重复随机等待已取消。服务失败每隔 5 分钟重试，6 小时内最多启动 3 次，单次最长 20 分钟；成功续期执行 `nginx -t` 和 reload。

验收：通过上述网络重试入口运行 `renew --dry-run --no-random-sleep-on-renew --run-deploy-hooks`，两张证书均显示成功（IP 与包含两个域名的证书），每张证书的部署 hook 均完成 Nginx 检查和重载。模拟续期没有替换正式证书。`systemd-analyze verify` 验证服务配置通过；正式 `systemctl start fitai-certbot.service` 返回 `Result=success`、`ExecMainStatus=0`，定时器启用并已安排下次运行。

首次变更前 Nginx 与环境配置备份：`/var/backups/fitai/domain-20261016-061108/`，环境备份继承原文件 600 权限。根域名变更前站点、旧续期服务与临时协议补丁备份：`/var/backups/fitai/root-domain-20261016-062049/`。没有修改账号数据、邀请码、模型密钥或业务代码。

## 2026-09-29 历史状态

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

## 首页改版（2026-10-16）

首页改为手机优先的产品展示页（当天先试深色主题，随后恢复原暖白配色）：首屏手机样机展示拍照识别结果，下方为功能卡片、三步流程、可交互的份量示例、体重趋势和隐私说明；手机端滚动后底部固定显示注册按钮。2.2 MB 的 `salmon-pasta-demo.png` 改为方形裁切的 `meal-400/720.webp`（22/55 KB，另有 JPEG 兜底），首页总传输量约 90 KB。`server.py` 新增 webp/jpg 类型，图片返回 `Cache-Control: public, max-age=2592000`，HTML、CSS、JS 与 API 仍为 no-store。

上线前备份：`/var/backups/fitai/landing-20261016-152231/`（旧 landing.html/css/js 与 server.py）。已重启 fitai，首页、CSS、图片、健康接口均 200，匿名 `/api/state` 401。

## 共享模型额度、免登录体验与 PWA（2026-10-16）

- 首页恢复原暖白配色（陶土红 `#bd4c2c`、鼠尾草绿趋势图），保留新布局；页脚及登录页显示 沪ICP备2026053161号。
- 共享 DeepSeek 额度：未填写个人 Key 的账号，每次 AI 请求（对话、教练、文字/图片/运动估算、模型测试）计 1 次，默认每人每天 30 次（`FITAI_SHARED_DAILY`），全站每天 1500 次（`FITAI_SHARED_GLOBAL_DAILY`）。估算接口此前没有每分钟限流，现已纳入。设置 →「AI 模型」显示今日剩余次数。
- 免登录拍照体验 `/api/trial/photo`：浏览器端先缩到 1024px JPEG，服务器只接受 2 MB 内的 JPG/PNG/WebP，不保存图片；每个 IP 每天 3 次（`FITAI_TRIAL_IP_DAILY`），全站每天 200 次（`FITAI_TRIAL_DAILY`），与登录用户共用 2 个 AI 并发槽。线上实测一张餐食照片 3.5 秒返回。
- PWA：`manifest.webmanifest`、`sw.js`（页面网络优先、离线时用最近缓存，`/api/` 不缓存）、`pwa.js`（安卓弹出安装、iOS Safari/微信提示操作步骤，应用内提示 14 天最多一次）及 192/512/maskable/apple-touch 图标。
- 错误响应改为关闭连接，避免开发服务器在提前拒绝请求后连接错位（生产 waitress 不受影响）。

上线前备份：`/var/backups/fitai/pwa-trial-20261016-155053/`。重启后首页、manifest、sw.js、图标、登录页、健康接口均 200，匿名 `/api/state` 401。

## 首页浅色化（2026-10-16）

首页「三步」区由深色改为浅暖色 `#f7f3ef`，应用内「添加到桌面」提示条也改为浅色。当天试用过一版「盘中下降线」标志，已被下一节的取景框标志取代。备份：`/var/backups/fitai/logo-20261016-155659/`。

## 更名「拍拍记」与取景框 logo（2026-10-16）

产品名由「简减肥」改为「拍拍记」：页面、PWA 名称、AI 系统提示、健康接口 `app` 字段与备份文件名同步更新；`简减肥` 加入旧品牌名单，旧备份仍可导入。标志改为深色圆角底 + 桃色取景框 + 餐盘（叶菜与番茄），资源版本 `logo.svg?v=snap-1`、图标 `?v=4`。域名仍为 www.jianjianfei.top。备份：`/var/backups/fitai/rename-paipaiji-20261016-160037/`（含旧 server.py）。


## 注册密码规则调整（2026-10-16）

注册和管理员重设密码改为 8–128 个字符，必须包含英文字母和数字，不强制大小写混合或特殊符号。登录只校验输入边界并验证原密码哈希，兼容历史不含数字的密码。注册页提示及前端校验同步更新。

账号测试 20 项：19 项通过、1 项跳过；前端表单检查覆盖短密码、缺少字母/数字、8 位注册及旧密码登录。线上 auth.html/auth.js 与本地修改一致，健康接口 200，服务器密码校验验证通过。备份：`/var/backups/fitai/password-8-20261016-170809/`。首次即时健康检查遇到启动中的 502，已自动回退；增加启动等待后重新发布成功。


## 手机顶部清晰度与底部导航（2026-10-16）

手机布局补齐顶部状态栏安全区；顶部和底部导航使用实色背景，手机端关闭装饰光晕和侧栏毛玻璃，收起侧栏时隐藏其渲染。底部导航改为悬浮圆角栏，位于底部安全区上方，图标 26px、文字 13px、按钮至少 58px 高；饮食/运动/体重与发送、图片按钮点击区域至少 44px。由主区域统一预留导航空间，取消输入区重复留白。

`account.css` 版本升为 `mobile-shell-2`。浏览器回归检查通过：320、393、430、844、980 和 1280px 布局，模拟 iPhone 顶部 59px/底部 34px 安全区，菜单开关、触控命中、页面底部无遮挡；现有长餐食弹窗（含模拟键盘）和趋势图回归通过。使用 Edge 浏览器和模拟数据验证，尚未用实体 iPhone Safari 复测模糊现象。

发布仅替换 `static/account.css`、`static/index.html`，未重启服务；线上内容与本地逐字节比对通过。备份：`/var/backups/fitai/mobile-shell-20261016-172007/`。


## 对话顶部新会话入口（2026-10-16）

对话页第一行新增「＋ 新会话」，复用侧栏新建逻辑，切到其他页面时隐藏。窄屏聊天页的顶部「我的」由底部导航承接，为新会话按钮保留空间。保留旧会话和生成中禁止新建的行为。

浏览器验证覆盖 320/393/430/844/980/1280px、顶部同一行布局、按钮点击、新会话切换与输入框聚焦、旧会话保留以及生成中拦截；17 项聊天和安全单元测试通过。三个静态文件发布后与本地逐字节比对一致，无需重启服务。备份：`/var/backups/fitai/top-new-chat-20261016-172237/`。


## iOS 27 主屏幕应用顶部模糊兼容调整（2026-10-16）

用户在 iPhone 14 Pro / iOS 27.0.1 从桌面图标打开，反馈上一轮实色化后顶栏仍模糊。结合 [WebKit 固定边缘与系统滚动边缘效果实现](https://github.com/WebKit/WebKit/pull/47943) 及 [iOS 27 实机实验](https://tips.ojapp.app/en/ios-27-pwa-top-blur-workaround-2/)，目前最符合现象的解释是系统滚动边缘模糊；网页自身的 backdrop-filter:none 无法直接关闭系统效果。

手机顶栏由普通流布局改为 position:fixed，锚定视口 top:0，实色背景覆盖全宽及顶部安全区，按钮仍位于安全区下方；主区域统一预留对应高度，取消外壳的重复顶部留白。CSS 版本为 ios-fixed-header-1。浏览器验证固定背景从 y=0 覆盖全宽、滚动不移动、控制按钮避开安全区、消息不被挡住，以及侧栏、新会话、长餐食弹窗交互。用户随后在同一台 iPhone 14 Pro / iOS 27.0.1 的桌面应用中实机确认：顶部文字已不再模糊，显示正常。

线上两份静态文件与本地比对通过，未重启服务。备份：`/var/backups/fitai/ios-fixed-header-20261016-172527/`。

## 自然语言记录与字体大小设置（2026-10-16）

移除输入框上方的饮食、运动、体重按钮及欢迎页分类入口，前端不再发送手动选择的 recording_intent；直接描述或上传照片，由模型判断并调用记录工具，保留原有确认流程。后端兼容接口保持不变。

「我的 → 字体大小」新增标准、大、特大三档，实时调整对话、记录卡片及设置文字，预览同步更新。选择保存在本设备浏览器的 localStorage，加载样式前恢复；存储不可用时仍能应用并提示无法保存。保留聊天草稿、顶部新会话入口与已实机确认的 iOS 固定顶栏修复。

验证：39 项前端聊天、编辑、安全、流式与图表测试通过，字体偏好单元测试通过，37 项模型工具测试通过。浏览器覆盖 320/393/430/844/1280px 三档字体、所有设置页、持久化恢复、草稿保留及记录确认布局；手机外壳与长记录弹窗回归通过。浏览器为 Edge 模拟视口，本次字体功能尚未进行实体 iPhone 验证。

发布四份静态文件并逐一核对线上 HTTP 200 与内容一致，无需重启服务。备份：`/var/backups/fitai/natural-chat-font-20261016-173449/`。
