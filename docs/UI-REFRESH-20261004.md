# 登录页与产品主页更新验收（2026-10-04）

已通过 SSH 别名 fitai-server 发布到 https://8.152.196.106/ 。

## 改动

- 主页参考 Apple 官网的留白、大标题与分段产品展示，保留渐渐飞品牌色。首屏展示餐食识别界面示意，下方保留可操作的营养份量与体重趋势示例。
- 登录页独立加载 public.css 与 auth.css，移除应用主界面 style.css 对 body 的滚动锁定。文档自然增高，注册与矮屏时可上下滚动。
- 桌面左右分栏，手机优先显示表单；输入框保持 16px 字号，支持密码显示、自动填充和提交中状态。
- 复用现有图片与原生前端，无新依赖。首屏餐食图优先加载，下方图片延迟加载。
- 原有账号切换按钮样式继续保留。账号接口、邀请机制、业务数据与模型配置未改动。

## 验证结果

- Python 账号测试：16 通过，1 跳过。
- Node 安全回归：4 通过；auth.js 与 landing.js 语法检查通过。
- 浏览器临时 QA 账号登录成功进入 /index.html；密码显示/隐藏可用。
- 营养演示调整到 200g 后合计 610 kcal，确认状态正确；趋势切换 30 天后显示 68.1 kg。
- 浏览器视口验证：320×568、390×844、768×1024、1440×900；登录注册另检查 844×390 横屏。无横向溢出，登录页纵向 overflow 为 auto。
- 公网 HTTPS 首页与邀请注册页正常加载；390×844 线上注册页滚动后提交按钮、提示与页脚均可见。
- 本轮为桌面浏览器视口模拟，未使用实体 iOS/Android 设备验证软键盘。
- 上线后 systemd 服务 active，健康接口正常。发布使用原子文件替换，无需重启服务。

## 发布与回退

本次六个文件：static/auth.html、static/auth.css、static/auth.js、static/landing.html、static/landing.css、static/public.css。

旧版备份：/var/backups/fitai/public-before-refresh-20261004.tar.gz。
发布包：/tmp/fitai-public-refresh-20261004/release.tar.gz。

回退时在服务器执行：

    tar -xzf /var/backups/fitai/public-before-refresh-20261004.tar.gz -C /opt/fitai

该命令恢复五个旧文件；新增 public.css 留在目录不影响旧页面。无需修改数据或重启服务。

线上截图保存在本机 .workbuddy/ui-refresh-20261004/（忽略提交）。
