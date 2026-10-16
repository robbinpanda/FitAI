# 手机趋势图修复（2026-10-04）

已发布至 https://8.152.196.106/ 。

原图表使用固定 480×250 的 SVG 画布，并设置 `preserveAspectRatio="none"`，在手机容器内发生非等比拉伸。现在根据容器实际宽高计算图表布局，保留 SVG 比例，统一刻度字体大小；容器尺寸变化时重新绘制。提示框位置同步使用实际 viewBox 和缩放比例计算。

验证：42 项前端测试通过。浏览器覆盖 320×568、390×844、844×390、768×1024、1024×768、1440×900 以及回到竖屏；检查 7 天/30 天、圆点比例、坐标文字边界、点击提示和能量单位。未进行实体 iPhone 验证。截图位于 `.workbuddy/trend-layout-qa/`。

发布文件：`static/app.js`、`static/style.css`、`static/index.html`。保留上一轮 Safari 地址栏修复，资源版本更新为 `responsive-trends-4`。公网三个文件的 SHA-256 与本地发布内容一致；服务 active，健康接口 200，匿名记录接口 401。无需重启服务，未修改数据。

回退包：`/var/backups/fitai/before-responsive-trends-20261004T102653Z.tar.gz`。

如需回退，在服务器执行：

```sh
tar -xzf /var/backups/fitai/before-responsive-trends-20261004T102653Z.tar.gz -C /opt/fitai
```
