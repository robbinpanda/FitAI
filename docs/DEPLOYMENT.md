# Ubuntu 24.04 / 阿里云 ECS 部署

这份配置面向 2 核 2 GB、少量受邀用户。运行一个 Python 进程，SQLite 按账号分文件；无需 Docker、Redis、Node.js 或 GPU。先完成本指南的验收，再邀请其他用户。

## 1. 准备条件

- 已能通过 VS Code Remote SSH 登录 Ubuntu 24.04。
- 一个解析到 ECS 公网 IPv4 的域名，用于 HTTPS；本文以 `fitai.example.com` 为占位符。
- 安全组：22 仅允许你的管理 IP；80 / 443 允许访客；**不开放 8765、数据库或管理端口**。
- 中国内地节点对外提供网站服务需按要求完成备案，见 [阿里云说明](https://help.aliyun.com/zh/icp-filing/basic-icp-service/getting-started/quick-start-for-icp-filing-for-personal-websites)。没有域名时可先完成代码准备，不要用公网 HTTP 输入密码、邀请码或 API Key。

服务器上的代码放在 `/opt/fitai`，账号数据放在 `/var/lib/fitai`。代码不能由网站进程改写。

## 尚未备案时：仅通过 SSH 私人预览

可以先部署应用，不开公网网站。`deploy/install-private.sh` 是初次安装脚本（先安装 Python venv 和 Nginx，且保持 Nginx 不运行），设置 `FITAI_MODE=server`、`FITAI_SSH_PREVIEW=1`、`FITAI_PUBLIC_ORIGIN=http://localhost:18765`。后端仍只监听服务器 `127.0.0.1:8765`，仍强制邀请码、登录、SSRF 白名单和所有服务器限制；不是把远端改成 local 模式。

在电脑 PowerShell 运行并保持终端打开：

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18765:127.0.0.1:8765 fitai-server
```

用 Chrome 或 Edge 打开 **http://localhost:18765**（必须是 localhost，不是公网 IP，也不是 127.0.0.1）。电脑与 ECS 之间由 SSH 加密；浏览器与本机隧道入口走回环 HTTP。Secure Cookie 仍保留，利用现代浏览器对 localhost 的可信例外；Safari 可能不支持此预览方式。此入口仅供持有 SSH 权限的管理员测试，不用于对外提供网站，不需要修改 DNS，也不要在服务器为它配置公网反向代理。

私有安装脚本把应用的 MemoryHigh / MemoryMax 收紧为 512 / 768 MiB，适合已有 VS Code 进程的 2 GB 实例。修改 `/etc/systemd/system/fitai.service.d/resources.conf` 后需 daemon-reload 和重启。

要正式上线：完成所需备案或将网站部署到香港等适当节点，关闭 `FITAI_SSH_PREVIEW`，把 `FITAI_PUBLIC_ORIGIN` 换为真实 HTTPS 域名，按下文配置证书及 Nginx并重启应用。如果之前为阻止安装时启动默认站点而执行过 `systemctl mask nginx`，完成 Nginx 配置并验证 `nginx -t` 后再 `systemctl unmask nginx`、启动。不要直接把私有预览端口公开。

## 2. 上传代码（在电脑 PowerShell）

在项目目录创建只包含代码的发布包，不含 `.git`、本地数据或密钥：

```powershell
tar -czf fitai-release.tar.gz server.py security.py production.py manage.py requirements-server.txt static deploy docs README.md
scp fitai-release.tar.gz fitai-server:/tmp/
```

`fitai-server` 是你 SSH config 中的 Host 名称。不要上传整个工作目录，特别是 `data/`、`.env`、`.pem`。

## 3. 安装运行环境（此后在 VS Code 的服务器终端）

以下初次安装命令适用于新服务器；已有部署先阅读升级步骤。

```bash
sudo apt update
sudo apt install -y python3 python3-venv nginx certbot
sudo useradd --system --home /var/lib/fitai --shell /usr/sbin/nologin fitai
sudo install -d -o root -g root -m 755 /opt/fitai
sudo install -d -o fitai -g fitai -m 700 /var/lib/fitai
sudo tar -xzf /tmp/fitai-release.tar.gz -C /opt/fitai
sudo chown -R root:root /opt/fitai
sudo python3 -m venv /opt/fitai/.venv
sudo /opt/fitai/.venv/bin/pip install --index-url https://pypi.org/simple -r /opt/fitai/requirements-server.txt
sudo install -m 600 /opt/fitai/deploy/fitai.env.example /etc/fitai.env
sudo nano /etc/fitai.env
```

把 `FITAI_PUBLIC_ORIGIN` 改为真实 HTTPS 域名。初期保持 20 个账号上限、512 MiB 账号配额、90 秒单次模型超时。`FITAI_MODEL_ORIGINS` 只填写你信任的服务商来源，例如 `https://api.deepseek.com`；用户填写的模型 Base URL 可以包含 `/v1`，但环境白名单不能包含路径。

## 4. 设置邀请码

```bash
sudo -u fitai /opt/fitai/.venv/bin/python /opt/fitai/manage.py invite --data-dir /var/lib/fitai --uses 5
```

在隐藏输入提示中输入你选择的邀请码两次，建议使用密码管理器生成的随机长字符串（至少 16 字符）。不要把邀请码写进命令行参数、环境变量、代码或聊天。只保存加盐 scrypt 哈希；最多成功注册 5 次，用完自动关闭。更换邀请码立即生效，旧邀请码失效，已有账号不受影响。

未配置邀请码时，server 默认关闭注册。初次注册的账号只是普通账号；管理操作只通过 SSH 终端完成。

其他管理命令：

```bash
sudo -u fitai /opt/fitai/.venv/bin/python /opt/fitai/manage.py close-registration --data-dir /var/lib/fitai
sudo -u fitai /opt/fitai/.venv/bin/python /opt/fitai/manage.py users --data-dir /var/lib/fitai
sudo -u fitai /opt/fitai/.venv/bin/python /opt/fitai/manage.py reset-password --data-dir /var/lib/fitai --username alice
```

重置密码会撤销该用户所有会话。邀请码次数与 `FITAI_MAX_USERS` 总数上限同时生效。没有网页管理后台。

## 5. 启动应用服务

```bash
sudo install -m 644 /opt/fitai/deploy/fitai.service /etc/systemd/system/fitai.service
sudo systemctl daemon-reload
sudo systemctl enable --now fitai
sudo systemctl status fitai --no-pager
curl -H 'Host: fitai.example.com' http://127.0.0.1:8765/api/health
```

将 curl 的 Host 换成真实域名。应用检查 Host，直接访问本机端口但不给正确 Host 会返回 403，这是预期行为。**不要用 `waitress-serve production:application` 启动**，它没有执行账号初始化，会返回 503；使用提供的 systemd 服务。

## 6. HTTPS 与 Nginx

如果系统 UFW 防火墙已启用，正式公开部署时还需 `sudo ufw allow 80/tcp` 和 `sudo ufw allow 443/tcp`，并同步配置阿里云安全组。SSH 私人预览阶段无需放开这两个端口。

先确认域名 DNS 已解析到当前 ECS，80 端口可达。以下使用 Certbot 的 standalone 验证，首次签发短暂停止 Nginx：

```bash
sudo systemctl stop nginx
sudo certbot certonly --standalone -d fitai.example.com
```

按提示填写邮箱并确认服务条款。然后安装配置：

```bash
sudo install -m 644 /opt/fitai/deploy/fitai-proxy.conf /etc/nginx/snippets/fitai-proxy.conf
sudo install -m 644 /opt/fitai/deploy/nginx.conf /etc/nginx/sites-available/fitai
sudo nano /etc/nginx/sites-available/fitai
```

把文件中**全部** `fitai.example.com` 改成真实域名，包括证书路径。新装 Nginx 的默认站点与模板的 default_server 冲突，移除默认启用链接（保留原配置）：

```bash
sudo unlink /etc/nginx/sites-enabled/default
sudo ln -s /etc/nginx/sites-available/fitai /etc/nginx/sites-enabled/fitai
sudo nginx -t
sudo systemctl start nginx
```

如果已存在其他网站，先合并默认虚拟主机配置，不要照搬移除操作。模板会拒绝未知 Host，强制 HTTP 跳 HTTPS，并覆盖客户端可伪造的代理头。

证书续期仍使用 standalone，需要在续期时释放 80 端口。创建 hooks 后验证：

```bash
sudo install -d /etc/letsencrypt/renewal-hooks/pre /etc/letsencrypt/renewal-hooks/post
printf '#!/bin/sh\nsystemctl stop nginx\n' | sudo tee /etc/letsencrypt/renewal-hooks/pre/fitai-nginx >/dev/null
printf '#!/bin/sh\nsystemctl start nginx\n' | sudo tee /etc/letsencrypt/renewal-hooks/post/fitai-nginx >/dev/null
sudo chmod 755 /etc/letsencrypt/renewal-hooks/pre/fitai-nginx /etc/letsencrypt/renewal-hooks/post/fitai-nginx
sudo systemctl enable --now certbot.timer
sudo certbot renew --dry-run
```

续期检查可能造成短暂网站中断；后续也可以切换为 DNS 验证或 webroot 以避免中断。

## 7. 上线验收

1. 打开 `https://你的域名`，确认显示「服务器版 · 邀请注册」，证书正常。
2. 不带邀请码、错误邀请码注册都应失败；正确邀请码成功，剩余次数减少。
3. 创建两个测试账号，在 A 录入体重，再切换 B，确认 B 看不到 A 的记录、聊天或模型配置。
4. 未登录直接访问 `/api/state`、`/api/export` 应返回 401；跨域来源应返回 403。
5. 配置自己的模型 Key，确认流式回复及时显示；确认后记录才保存。
6. 检查 `ss -lntp`，8765 只监听 127.0.0.1；安全组不放行该端口。
7. 在低峰重启 `fitai` 并重新访问，确认账号、数据和登录状态仍在。
8. 用下节命令检查内存和磁盘，并做一次备份恢复演练。

## 8. 2 核 2 GB 的容量和限制

| 项目 | 默认限制 |
|---|---|
| 应用进程 | 1 个，不要多进程或多副本 |
| HTTP 工作线程 | 6 个，适配器最多另有 6 个处理线程 |
| AI / 模型测试 / 搜索并发 | 全局最多 2 个；后台识别也共享额度 |
| 密码/邀请码计算 | 同时 1 个，scrypt 约 16 MiB 工作内存 |
| HTTP 请求体 | 8 MiB（JSON 内的图片 base64 也算在内） |
| 模型 SSE 响应 | 每次最多 4 MiB；普通 JSON 最多 2 MiB |
| 单会话页面历史 | 最近 200 条；完整历史保留在库中 |
| 在线备份导出 | 账号数据文件合计超过 16 MiB 时转管理员离线备份 |
| systemd 内存 | MemoryHigh 900 MiB、MemoryMax 1200 MiB |
| systemd CPU | 最多约 1.5 核，给系统和 Nginx 留空间 |

这不是“20 人同时聊天”的承诺；20 是注册总数上限。模型调用主要在等待外部 API，但图片、导入和 JSON 序列化会占内存。建议先邀请 3–5 人验证，之后根据监控扩容或提高配额。浏览器取消生成不一定立即停止上游服务商计费；后台任务真正退出前不会释放并发额度。

```bash
free -h
df -h /var/lib/fitai
sudo systemctl show fitai -p MemoryCurrent -p MemoryPeak -p TasksCurrent
sudo journalctl -u fitai -n 100 --no-pager
```

如出现 429，稍后重试，不要直接增加线程；如触发 MemoryMax，服务可能被系统终止并重启，应检查日志、缩小图片或升级内存。账号磁盘配额为写入前检查，不是硬文件系统配额；管理员需定期清理已验证可删除的历史备份，并监控总磁盘。应用拒绝在剩余磁盘少于 512 MiB 时继续普通写入。

## 9. 备份、恢复和旧数据迁移

完整备份包括账号库、会话、业务 API Key、照片；只存放在可信位置，异地副本应加密。

```bash
sudo sh /opt/fitai/deploy/backup.sh
```

脚本短暂停止应用，以保证 SQLite 和照片一起一致，然后自动重新启动。生成 `/var/backups/fitai/fitai-时间.tar.gz`，只有 root 可读。请将备份保存到独立存储并定期演练恢复；同一 ECS 上的备份无法应对磁盘丢失。保留周期按磁盘容量制定，脚本不会自动删除备份。

恢复时先停止服务，把当前目录移到一个不存在的保留目录，再从可信备份恢复；不要覆盖唯一的数据副本：

```bash
sudo systemctl stop fitai
sudo mv /var/lib/fitai /var/lib/fitai-before-restore-YYYYMMDD
sudo tar -xzf /var/backups/fitai/你的备份.tar.gz -C /var/lib
sudo chown -R fitai:fitai /var/lib/fitai
sudo chmod 700 /var/lib/fitai
sudo systemctl start fitai
```

恢复账号库可能恢复当时尚未过期的会话；事故恢复后可用管理命令重置相关用户密码以撤销会话。

旧单用户版数据迁移请先按 README 在本地导出并导入目标本地账号。大于 8 MiB 的备份不能在线导入服务器：管理员应先在服务器注册目标账号，执行 `manage.py users` 找到其随机 ID，停止两边应用，备份服务器数据，然后仅将本地该账号的 `fitai.db`、存在的 `fitai.db-wal` / `fitai.db-shm` 及 `photos/` 放到服务器目标账号目录，修正所有权后启动。**不要复制 accounts.db，也不要覆盖其他用户目录。** 数据库带有该账号 API Key，传输必须走 SSH；也可先在本地清除 Key 再迁移。完整文件复制步骤中的 WAL 文件如果存在必须一起保留。

## 10. 更新和回滚

1. 先在本机运行回归测试，重新生成只含代码的发布包并上传。
2. 做完整数据备份；保存当前 `/opt/fitai` 的代码副本与 `/etc/fitai.env`。
3. 停止服务，在 `/opt/fitai` 更新代码和依赖；保持 root 所有权，不覆盖 `/var/lib/fitai`。
4. 如更新了服务文件或配置，重新安装并运行 `systemctl daemon-reload` / `nginx -t`。
5. 启动服务并按上线验收检查。数据库迁移在该账号首次访问时执行，迁移前有数据库快照。
6. 回滚时恢复相匹配的旧代码和升级前数据备份；不要直接用旧代码读取已经升级的库。

## 11. 常见问题

- **502**：检查 `systemctl status fitai` 和日志；确认环境文件域名有效、依赖安装完成。
- **403 来源不受信任**：公网域名、`FITAI_PUBLIC_ORIGIN`、Nginx 的 Host 必须一致，不要通过裸 IP 登录。
- **注册未开放**：检查邀请码剩余次数、总用户数；修改邀请码无须重启，修改环境变量需要重启。
- **模型地址被拒绝**：管理员把确实可信的 HTTPS 来源加入白名单后重启。不要放行回环、私网、元数据地址或用户自建的不可信域名。
- **模型超时**：确认 ECS 所在地域能访问服务商；网络可达性与服务商额度要在真实服务器验证。
- **413**：压缩照片或减少一次上传数量；较大的迁移/备份使用离线方式。
- **大量扫描或洪泛**：本项目限流控制应用开销，不能消除带宽级 DDoS；按实际流量启用阿里云防护。当前 Nginx 模板假定直接接收访客连接；接入 CDN/WAF 前需按供应商可信代理范围重新配置真实 IP，不能信任任意转发头。


## 站点共享 API 默认值

服务端可通过 `FITAI_SHARED_API_KEY`、`FITAI_SHARED_BASE_URL`、`FITAI_SHARED_MODEL` 和 `FITAI_SHARED_TAVILY_API_KEY` 配置共享模型和搜索。仅 server 模式启用；不自动读取或共享本地旧数据库。个人 Key 优先，删除个人 Key 后恢复站点默认值。联网搜索开关仍由各用户控制。

北京实例的共享密钥单独保存在 `/etc/fitai-shared.env`（root:root，600），由 `/etc/systemd/system/fitai.service.d/shared-api.conf` 的 `EnvironmentFile=/etc/fitai-shared.env` 加载。更新后重启 `fitai`。密钥不进代码、前端响应、个人数据库或用户导出；系统管理员仍可读取该文件，应单独安全备份。共享调用使用站点配置的地址及模型，用户不能借共享密钥更换服务地址或模型。共享调用费用由站点所有者承担，现有并发与请求限流不等于费用硬上限，预算上限应在服务商控制台配置。
