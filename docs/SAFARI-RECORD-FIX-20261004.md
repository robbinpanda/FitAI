# Safari 记录弹窗适配发布（2026-10-04）

已发布到 https://8.152.196.106/ ，使用现有 SSH 别名 `fitai-server`。

- 食物列表独立滚动，确认操作位于弹窗固定的底部区域。
- 使用 `100svh` 限制弹窗高度，为 Safari 展开的地址栏留出空间；结合 visualViewport 处理键盘缩小可用区域。
- 更新页面资源版本，重新打开弹窗时重置内容滚动位置。

发布文件：`static/app.js`、`static/style.css`、`static/index.html`。先备份再逐个原子替换，未重启服务，未修改数据或服务器配置。

验证：41 项前端测试通过；浏览器覆盖 320×568、390×844、844×390、1280×800，含 8 个食物、滚动、模拟地址栏高度与延迟更新、模拟键盘、确认和重新打开。尚未使用 iPhone Safari 真机验证。公网 HTTPS 返回的三个文件均与本地发布内容 SHA-256 一致；健康接口 200，服务 active，匿名记录接口 401。

旧版备份：`/var/backups/fitai/before-safari-viewport-20261004T100356Z.tar.gz`。

发布包：`/tmp/fitai-safari-01a10647.tar.gz`。

需要回退时，在服务器执行：

```sh
tar -xzf /var/backups/fitai/before-safari-viewport-20261004T100356Z.tar.gz -C /opt/fitai
```

恢复上述三个前端文件即可，无需恢复数据库或重启服务。
