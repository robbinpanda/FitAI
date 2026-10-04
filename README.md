# 简减肥 · 个人健康记录助手

品牌现为「简减肥」，兼容原「渐渐飞」及 FitAI 数据备份。本机启动脚本沿用原文件名。

`main` 包含账号系统、邀请注册、共享 API、展示主页与服务器部署配置，同时保留本地运行方式。

用自然语言记录饮食、运动和体重，在确认后写入数据；结合近期记录与可选联网搜索，获得 AI 教练建议。支持本地使用和服务器邀请注册。

## 从这里开始

- **本机使用**：Python 3.10+（含 SQLite、scrypt），运行 `python server.py`，或 Windows 双击 `启动 渐渐飞.bat`。创建本地账号后登录，无需邀请码。
- **阿里云 ECS 部署**：阅读 [Ubuntu 部署指南](docs/DEPLOYMENT.md)。默认面向 **2 核 2 GB、小规模邀请使用**，不需要 GPU、Redis 或独立数据库。
- **管理员**：用 `manage.py` 设置邀请码、关闭注册、列出账号、重置密码或导出旧版数据。
- **安全边界与限制**：阅读 [安全设计](docs/SECURITY.md)。

## 功能

- **AI 对话**：流式回复、图片识别、可选 Tavily 联网搜索；新增、修改、删除记录都需要确认。
- **今日概要**：汇总已记录摄入与运动，支持手动编辑、删除与撤销。
- **趋势**：展示实测体重与已记录能量，不把缺测日期当成零。
- **用户账号**：注册、登录、退出并切换账号；独立档案、设置、API Key、照片、聊天和备份。
- **模型配置**：支持 OpenAI 兼容 API。服务器版只能使用管理员允许的 HTTPS 模型地址；每个账号自备 API Key。

营养估算并非精确测量；照片份量、烹饪用油和检索来源均存在不确定性。内部统一使用 kJ，界面可以显示 kcal（1 kcal = 4.184 kJ）。

## 本地模式与服务器模式

| 项目 | local（默认） | server |
|---|---|---|
| 启动 | `python server.py` | `python production.py` |
| 注册 | 无需邀请码，仍需账号密码 | 管理员邀请码 + 剩余次数 + 账号总数上限 |
| 访问 | 仅 127.0.0.1 | Nginx HTTPS → 本机 Waitress |
| 数据 | 本机账号目录 | 服务器账号目录 |
| 会话 | HttpOnly、SameSite=Strict | 额外强制 Secure Cookie |
| 模型地址 | 允许本机模型服务 | 可信 HTTPS 来源白名单 + 公网 IP 检查 |
| 依赖 | Python 标准库 | 增加 Waitress；系统层 Nginx |

模式只由启动环境变量决定，不能通过访问 `localhost`、修改 Host 或代理头切换。两套部署的账号不会自动同步。

## 第一次使用

1. 启动后进入登录页，注册用户名（3–32 位字母、数字、下划线或短横线）和密码（12–128 字符）。服务器版还需邀请码。
2. 在「设置 → 个人档案」填写目标；在「AI 模型」设置模型地址、名称和自己的 API Key。
3. 可选：在「联网搜索」填写 Tavily Key 并启用。搜索与模型调用会使用各自服务商额度。
4. 页面右上角显示用户名，点击「切换」注销当前会话并返回登录页。切换会清除未发送草稿；同一浏览器标签页共享当前账号。

忘记密码由服务器管理员在终端重置，不提供邮件找回，也没有默认管理员密码。

## 旧版数据迁移

旧的 `data/fitai.db` 和照片**不会自动分配给首个注册用户**，避免别人抢先注册获得历史数据。原文件保留。

先停止旧版进程，备份整个 `data/`，再在原项目目录执行：

```powershell
python manage.py export-legacy --data-dir data --output legacy-export.json
```

运行新版本并登录目标账号，在「设置 → 数据与隐私」导入导出的文件。导入会替换该账号原有业务数据，并先创建备份；请确认账号。导出不含 API Key，需要重新填写。

服务器在线导入最多 8 MiB；超过此大小请先在本地完成导入，再由管理员离线迁移该账号数据库和照片，详见部署指南。不要把整个本地 `data/` 随代码上传。

## 数据目录

```text
data/                         # 服务器默认改为 /var/lib/fitai
├── accounts.db               # 用户、密码哈希、会话摘要、邀请码哈希、限流计数
├── users/
│   └── <随机账号 ID>/
│       ├── fitai.db           # 该用户的业务数据和 API Key
│       ├── photos/           # 该用户的餐食照片
│       └── backups/          # 迁移/导入前的数据库快照
└── fitai.db                  # 如存在，是保留的旧版单用户数据库
```

**服务器版的数据和 API Key 存在服务器上。** 业务 API Key 需要用于调用服务商，当前以明文保存在受操作系统权限保护的账号数据库中；密码和邀请码则只存不可逆哈希。服务器管理员仍能访问账号文件。数据库、照片和整机备份都应作为敏感数据保管。

## 环境配置

| 变量 | 默认值 | 用途 |
|---|---|---|
| `FITAI_MODE` | `local` | `local` 或 `server` |
| `FITAI_DATA_DIR` | 项目 `data/` | 账号与数据根目录 |
| `FITAI_PUBLIC_ORIGIN` | 空 | server 必填，例如 `https://fitai.example.com` |
| `FITAI_SSH_PREVIEW` | 关闭 | 设为 `1` 仅允许 SSH 私人预览的 `http://localhost:端口`，保持 server 邀请制；禁止公网代理此预览入口 |
| `FITAI_PORT` | `8765` | 本机监听端口；生产模式端口占用直接失败 |
| `FITAI_TIMEOUT` | `150` | 单次模型调用超时；服务器模板设为 90 秒 |
| `FITAI_MAX_USERS` | `20` | 当前部署账号总数上限 |
| `FITAI_USER_QUOTA_MB` | `512` | 单账号写入前存储检查，包含自动备份 |
| `FITAI_MODEL_ORIGINS` | DeepSeek、OpenAI 官方 HTTPS 来源 | server 模型来源白名单，逗号分隔，不含路径 |

完整服务器示例见 [deploy/fitai.env.example](deploy/fitai.env.example)。应用不会自动读取 `.env`；服务器使用 systemd 的 `EnvironmentFile`。`FITAI_DB` 仅保留给旧版迁移和测试，不用于选择已登录用户的数据库。

## 验证

```powershell
python -m unittest discover -s tests -p "test_*.py"
node --test tests/test_chat_intent.cjs tests/test_record_editor.cjs tests/test_streaming.cjs tests/test_charts.cjs tests/test_security.cjs
python -B tests/ui_smoke_server.py --demo-stream
```

UI 验证使用临时数据和模拟模型，控制台显示测试地址与测试账号，不调用真实 AI。安装 `requirements-server.txt` 后，可加 `--production` 验证 Waitress 流式入口。真实 ECS 的 TLS、Nginx、systemd、网络连通和负载表现仍需按部署指南验收。

## 代码导航

- `server.py`：业务接口、Agent、SQLite、本地入口。
- `security.py`：身份隔离、密码与邀请码哈希、会话、限流及 SSRF 防护。
- `production.py`：有界 WSGI 流式适配与 Waitress 生产入口。
- `manage.py`：仅服务器终端可用的管理工具。
- `static/`：原生 HTML / CSS / JavaScript，无需前端构建。
- `deploy/`：systemd、Nginx、环境配置与备份脚本。
- [AGENT设计.md](AGENT设计.md)：Agent 工具协议与记录确认逻辑。


### 站点默认 API

服务器可配置站点共享 DeepSeek / Tavily API，登录用户未保存个人 Key 时自动使用默认值；保存个人 Key 后优先使用自己的，删除后恢复默认。设置页提供删除按钮和两个官方 Key 获取入口。联网搜索仍需开启个人搜索开关。共享密钥只在服务器保存，不返回浏览器、不进入用户导出。配置方式见 [部署文档](docs/DEPLOYMENT.md#站点共享-api-默认值)。
