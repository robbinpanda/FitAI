# FitAI 2.0 · 个人减脂 Agent

本地运行的对话式减脂 Agent：用户只需要说出吃了什么、做了什么，FitAI 会把内容整理成结构化工具调用，在用户确认后记录饮食 / 运动 / 体重；不需要记录时，它就是一名基于真实近况回答的 AI 教练。

主界面现在只有三个入口：**AI 对话、今日概要、趋势**。原先分散的饮食识别、运动估算和教练能力已合并到对话中。详细协议、上下文选择与联网搜索方案见 [AGENT设计.md](./AGENT设计.md)。

### 本次体验与准确性优化

- **实时回复**：聊天使用 POST SSE，逐段显示回复和搜索／营养复核状态；生成中的文字标记为「待校验」。工具参数不会以原始 JSON 显示，只有最终校验完成后才出现确认卡片。旧版普通 JSON 接口继续可用。
- **停止与恢复**：可以停止等待，恢复本次文字、图片与记录意图；断流或失败显示持续可见的重试入口，不自动重发。停止关闭浏览器连接，上游模型若仍在等待网络响应，可能直到下一段输出或超时才结束，不能保证立即停止服务商计费。
- **营养数据检查**：对初次 AI 饮食草稿（含批量新增）检查克重、缺失／负数营养和营养素总质量，非标签项还复核能量一致性。缺少克重不再悄悄按 100g 生成 Agent 记录。与本地库精确同名的基础食物按克重核算；品牌、复合菜、标签值和带来源链接的数据不会被此规则覆盖。确认阶段保留用户手动修正。
- **记录动线**：输入区常驻饮食、运动、体重入口；确认弹窗展示估算备注和成分表／标签依据。完善模型配置提示、中文输入法 Enter 处理、移动端字号、固定确认按钮、弹窗键盘焦点和图片大小提示。上翻历史时暂停自动跟随，点击「回到最新」继续跟随。

这些检查减少单位、份量和数据一致性错误；照片估重、烹饪用油及来源本身仍有不确定性，并不代表已经通过真实餐食数据集验证准确率。

验证命令（均使用临时测试数据，不调用真实模型）：

```powershell
python -m unittest discover -s tests -p "test_*.py"
node --test tests/test_chat_intent.cjs tests/test_record_editor.cjs tests/test_streaming.cjs tests/test_charts.cjs
python -B tests/ui_smoke_server.py --demo-stream
```

最后一条启动独立 UI 验证服务，终端输出测试地址，模拟 200g 米饭的流式回复与确认流程；不读取正式 API Key 或记录。

体重趋势图提供日期横轴、kg 纵轴与刻度；鼠标移动到图表中、手机点击或键盘聚焦称重点，会显示实测日期和体重，方向键可切换记录。缺测日期不生成体重点。使用 `python -B tests/ui_smoke_server.py --demo-trend` 可在临时库检查趋势图。

入口不是记录事实：「记录饮食」「记录运动」仅切换本轮输入意图，显示输入提示，不填示例、不自动发消息；「问问教练」「去对话补充」仅聚焦对话框。「让 Agent 总结」只填入待发送的问题，保留已有草稿，用户点发送才请求 AI。记录模式可退出，并在成功发送后清除；明确问题、计划和否定不因模式而自动录入。没有具体内容的记录请求只追问，不从旧对话复制食物/运动。

每天无需「完成今日记录」：新增、修改、删除后概要直接汇总已有记录；趋势均值使用有饮食记录日，未记录日不是摄入 0。统计称为「已记录摄入」，不推定全天完整；体重趋势使用实测体重，不把一顿饭外推为周减重。

手动修改：在「今日概要 → 今天的记录」点击饮食或运动旁的「编辑」。可切换日期修改历史记录，保存只更新原记录，不重复新增。饮食编辑和 Agent 录入确认弹窗中，调整克重会同步按比例换算热量、蛋白质、碳水和脂肪；直接修正营养值后，后续换算采用修正后的基准。保留来源、标签标记和备注。克重缺失或为 0 且没有有效基准时，须手动填写营养数据，不能自动推算。

手动删除：饮食和运动的编辑弹窗左下角提供红色「删除记录」。确认时显示原记录日期与名称，只删除原记录，不提交未保存的编辑。删除后记录列表下方提供「撤销删除」，当前页面保留最近 5 个撤销入口；刷新后仍可让 Agent 恢复 7 天内的误删记录。

Agent 现在也能管理记录：查询历史明细/某日概要、修改或删除饮食/运动/体重、恢复 7 天内误删记录，并用 `manage_records` 一次确认完成最多 20 项混合操作（例如删除错误牛肉，替换成正确卤味）。所有删改恢复都展示真实记录 ID、日期和变更预览后再执行。确认前目标已变化会返回冲突；批量操作任一失败全部回滚。新增结果包含真实记录 ID，供后续追问定位。仅查询和分析不会写入。

- **零第三方依赖**：后端只用 Python 标准库（`http.server` + `sqlite3` + `urllib`），前端原生 HTML/CSS/JS，图表手写 SVG。双击 `.bat` 即用。
- **数据只在本机**：记录存在 `data/fitai.db`（SQLite），餐食照片存在 `data/photos/`。API Key 也只存本机。
- **模型可选**：配置任意 OpenAI 兼容接口即可用 AI 识别（文字 / 图片）与 AI 教练；不配置则走本地食物库 / MET 表。

内部能量单位一律是 **千焦 kJ**（`1 kcal = 4.184 kJ`）。界面可切换显示千卡，只改显示，不改存储。

---

## 快速开始

### Tavily 联网搜索

在「设置 → 联网搜索」输入自己的 Tavily API Key，勾选「启用联网搜索」并保存。对话框下方也有联网开关，可随时开关；关闭后不会调用 Tavily。留空保留已有 Key，移除 Key 会同时关闭搜索。

AI 通过 JSON `search_web` 只读工具按需检索（每轮最多两次），拿到资料后再回答或生成待确认记录。回复和确认弹窗展示来源 URL、查询时间；来源随对话和备份保留。只提问热量不会自动录入，所有记录仍需确认。

品牌、连锁餐厅、外卖和包装食品在联网开启时会经过服务端检索门禁：即使模型漏掉 `search_web`，后端也会先用产品名称发起查询，再允许生成待确认记录。中国用户默认核对中国大陆版本；其他国家或地区的同名产品只能作为旁证。模型给出的非标签能量还会按三大营养素做 17/17/37 kJ/g 一致性复核，差异超过 20% 时自动要求重算，不能把矛盾数值直接交给用户确认。

后端调用 Tavily Search 固定接口，使用 `advanced`、每次最多 8 条相关内容摘要，不抓取原始网页；高级查询比基础查询消耗更多额度，但更适合核对具体品牌和地区版本。「测试连接」也会查询一次。Key 仅保存在本地 SQLite，不返回前端明文、不发送给 AI、不写入备份。搜索服务接收 AI 提炼的产品查询词，模型接收检索摘要。搜索失败会显示原因，聊天可继续，但结果只能明确标注为估算。

注意：搜索摘要不保证有完整营养表；模型须核对地区、份量、单位和数据来源，不能把第三方摘要说成官方精确值。

双击 `启动 FitAI.bat`，浏览器会打开 `http://127.0.0.1:8765`。关闭命令行窗口即停止服务。

脚本先检查当前用户的 Workbuddy、Miniconda/Anaconda 和常见 Python 安装目录，再尝试 `py -3` 和 PATH 中的 `python`（跳过 WindowsApps 商店占位程序）。要求 Python 3.10 或更新版本并支持 SQLite。

Windows 启动脚本必须保存为 **UTF-8 无 BOM、CRLF 换行**；LF 换行可能让 `cmd.exe` 截断中文行附近的命令，出现 `ATH`、`erver.py` 等“不是命令”的错误。`.gitattributes` 已固定 `.bat` 使用 CRLF。启动后的实际地址以控制台输出为准，端口占用时可能顺延。

需要不自动打开浏览器时，可以在 PowerShell 执行 `& '.\启动 FitAI.bat' --no-browser`。保留启动窗口即可继续使用；关闭窗口停止服务。

手动启动：

```powershell
python server.py            # 启动并自动打开浏览器
python server.py --no-browser
```

可选环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `FITAI_PORT` | `8765` | 监听端口（被占用时顺延，最多再试 11 个） |
| `FITAI_TIMEOUT` | `150` | 调用模型的单次超时（秒） |
| `FITAI_DB` | `data/fitai.db` | 数据库路径（测试用临时库时覆盖） |

首次使用建议先在「设置 → 个人档案」填身高、体重和目标。没有 API Key 也可以手记饮食 / 运动 / 体重。

服务只监听 `127.0.0.1`。写接口需要本页下发的会话令牌，并检查 Host / Origin。

---

## 目录结构

```
减肥ai/
├─ server.py               # 后端入口：HTTP + SQLite + 模型调用
├─ static/
│  ├─ index.html
│  ├─ app.js
│  └─ style.css
├─ data/fitai.db           # 运行时自动创建
├─ data/photos/            # 保存到本日饮食的餐食照片
├─ data/backups/           # 迁移 / 导入前的一致性备份
├─ tests/test_fitai.py     # 临时库回归（不调用真实模型）
└─ 启动 FitAI.bat
```

---

## 数据模型（SQLite）

`init_db()` 创建表并用 SQLite backup API 做迁移前备份。`meals.kcal` / `exercises.kcal` **列名沿用，存的是 kJ**。接口新字段为 `energy_kj`。不要按数值大小猜单位。

| 表 | 关键字段 | 说明 |
|---|---|---|
| `profile` | gender, age, height, activity, start_weight, target_weight, weekly_loss, completed | 单行档案。`weekly_loss=0` 表示维持，不会被改成 0.5 |
| `settings` | api_key, base_url, text_model, vision_mode, vision_* | `vision_mode` 为 `inherit` 或 `custom`，不再用「有没有视觉 Key」推断 |
| `meals` | date, meal_type, name, amount, grams, kcal(=kJ), protein, carb, fat, item_source, from_label, energy_mode, base_* , photo_id, deleted_at | 每行一个食物。软删除后可撤销。`photo_id` 指向保存时上传的餐食照片 |
| `meal_photos` | date, meal_type, filename, mime | 文件在 `data/photos/`。保存饮食时若带图则留下，供回顾 |
| `exercises` | date, type, minutes, kcal(=kJ), met, energy_mode, source, deleted_at | `met` 估算或手填消耗 |
| `weights` | date(UNIQUE), weight, note | 每天最多一条实测 |
| `day_flags` | date, meals_complete | 旧版兼容备份字段，现已停用，不参与汇总或模型上下文 |
| `coach_sessions` | id, date, title, created_at, updated_at | 按固定记录日期保存的教练会话 |
| `coach_messages` | session_id, role, content, images, reasoning | 会话消息与可选多图；图片保存在本机 SQLite，旧版单图字段继续兼容 |
| `ops` | id | 保存 / 复制的幂等操作 ID |
| `meta` | energy_unit, schema_version, display_unit | 显示偏好 ≠ 存储单位 |

`settings.api_key` 不会通过接口回传。`/api/state` 只返回掩码和 `has_key`。导出备份默认不含 Key。

---

## HTTP 接口

写接口（POST）需要请求头 `X-FitAI-Token`（或 Cookie `fitai_token`），值来自 `/api/state` 的 `session_token`。能量字段请用 `energy_kj`；兼容旧字段 `kcal`（仍按内部 kJ 理解，除非带 `energy_unit: "kcal"`）。

### GET

| 路径 | 参数 | 返回 |
|---|---|---|
| `/api/health` | — | `{ok, app: "FitAI", version, schema_version, energy_unit}`，供启动探测 |
| `/api/state` | `date` | 当天汇总 + settings + `session_token` + `display_unit` |
| `/api/history` | `days`(7–180), `end` | 自然日数组。`end` 为截止日期（历史教练用） |
| `/api/weights` | — | 最近 200 条体重 |
| `/api/export` | — | 版本化备份 JSON（`schema_version` / `energy_unit` / `exported_at`） |
| `/api/copy_preview` | `from` | 预览可复制的饮食 |
| `/api/photo` | `id` | 返回已保存的餐食照片 |
| `/api/job` | `id` | 识别任务快照 |
| `/api/coach/sessions` | — | 所有会话，最近更新优先 |
| `/api/coach/session` | `id` | 指定会话及消息 |
| `/api/coach/image` | `id`（消息 ID）、`index`（从 0 开始） | 聊天图片 |

当天汇总里会标明：

- `weight` / `weight_source` / `weight_date`：`measured`（当天实测）、`last_measured`（历史实测）、`profile` / `estimate`（无实测，主数字应显示「未记录」）
- `meal_status`：`none` / `logged`，只表示是否已有饮食记录，不需确认完整度
- `target_is_estimate`：档案未完善时目标为暂估
- `macro_targets`：蛋白质 1.6 g/kg、脂肪约占能量 25%、碳水补足剩余
- `net`：已录入摄入与估计日消耗的差额，非实测全天缺口；`predict_delta` 始终为 `null`。旧兼容字段 `logged_weekly_kg` 不在 UI 或模型上下文使用
- `energy_unit`: `"kJ"`

### POST

| 路径 | 说明 |
|---|---|
| `/api/profile` | 更新档案。非法数字 / 超范围返回 400，不填默认值掩盖错误 |
| `/api/settings` | 更新模型。Key 操作：`keep`（默认，空白保留）/ `replace` / `clear`。`vision_mode` 显式区分继承与自定义 |
| `/api/analyze_text` | `{text, local?}` → `{job_id}` |
| `/api/analyze_image` | `{image, hint}`；视觉关闭或未配 Key 会失败并提示手填 |
| `/api/analyze_exercise` | `{date, type, minutes, text, local?}` |
| `/api/job/cancel` | 停止等待（后台请求可能仍在跑，结果不会写入草稿） |
| `/api/meal` | `{date, meal_type, items[], source, op_id, image?}` 保存一餐。带 `image` 时照片写入该餐，可在当日饮食里回顾 |
| `/api/meal/update` | 编辑已保存条目（名称 / 日期 / 餐次 / 克重 / 营养） |
| `/api/meal/delete` | 软删除，返回 `undo` |
| `/api/exercise` | 单条或 `items[]`。缺消耗时按 MET × 体重估算 |
| `/api/exercise/update` | 编辑已保存运动 |
| `/api/exercise/delete` | 软删除 |
| `/api/restore` | `{kind, id}` 撤销删除 |
| `/api/weight` | upsert 当天体重 |
| `/api/day_complete` | 已停用，返回 410；已有记录直接汇总 |
| `/api/copy_day` | `{from, date, meal_types?, ids?, op_id}` 追加复制 |
| `/api/coach/session/create` | `{date, title?}` 新建独立会话，日期固定 |
| `/api/coach/session/rename` | `{session_id, title}` 重命名 |
| `/api/coach/session/clear` | `{session_id}` 清空消息 |
| `/api/coach/session/delete` | `{session_id}` 删除会话及消息 |
| `/api/coach` | `{session_id, question?, images?: [dataURL]}` 多轮提问，一次最多四张、图片合计不超过 12 MB；旧 `image` 单图参数兼容。图片走视觉模型，历史只截止会话日期 |
| `/api/agent` | `{session_id, date, question?, images?, stream?}` 统一 Agent；默认返回 `{reply, tool_calls, message_id}`。`stream:true` 返回 SSE：`status` 进度、`reply` 当前阶段完整文字快照（可重置为空）、`done` 最终结果或 `error`。写入型调用先保存为 `pending` |
| `/api/agent/tool` | `{session_id, message_id, call_id, decision, arguments?}` 确认、校正或拒绝工具调用；只有 `confirm` 才写数据库 |
| `/api/test_key` | 测试**文本**模型 |
| `/api/test_vision` | 测试**视觉**模型（发一张 1×1 图，不拿文本测试冒充） |
| `/api/import` | 完整恢复。先自动备份，失败则回滚 |
| `/api/prefs` | `{display_unit: "kJ"|"kcal"}` |

非法日期、负数营养、NaN/Infinity、超长字符串、错误餐次、列表形状错误一律 400，数据库不变。未知内部错误返回通用 500 和 `log_id`，不回传堆栈。

导入仅接受含 `app: "FitAI"`、整数版本、明确能量单位、完整档案及四组记录数组的备份。整个文件校验完成后才备份和恢复。无版本/无单位的旧 JSON 不会自动猜测和导入，以免清空记录或造成单位偏差；恢复不覆盖现有模型 Key。

---

## AI 识别流程

异步任务 + 前端轮询。饮食和运动任务隔离，结果按任务自己的 `job_id` / 日期归位。

```
前端 POST /api/analyze_text  （或 analyze_image / analyze_exercise）
      └─ 并发上限 3；超限 429
      └─ 后台线程：call_model 流式 → JSON → grounding → 结果
前端轮询 GET /api/job?id=...
      └─ running / done / error / cancelled
```

- 模型输出里标明 kJ / kcal 的按标签换算；单位缺失才推断，并留下原因，不覆盖原值。
- 保存接口只校验，不做营养学猜测。
- 认证失败（401/403）不反复重试；限流最多退避两次。
- 任务有总时限和输出长度上限。

### 本地估算

- 食物：关键词匹配成分表。`米饭 200g 鸡蛋 50g` 按紧挨着的克数分别换算；`番茄炒蛋` 不会被拆成「番茄」。
- 未命中时给出占位行并标明「未精确匹配」，能量为 0，请手填。不要把占位值当成测量结果。
- 运动：Compendium MET × 体重 × 时长，再换成 kJ。这是运动时段总消耗（含这段时间的基础代谢），与全天 BMR 相加时有少量重叠，界面按估计使用，没有改成净消耗公式。

营养标签面板不走模型：填 kJ 或 kcal，或只填三大营养素按 17/17/37 kJ/g 计算，再按实际克重缩放。

---

## 代谢口径（`day_summary()` / `history()` 共用）

- **BMR**：Mifflin-St Jeor。
- **TDEE** = BMR + NEAT + 运动 + TEF（摄入 ×10%，仅已记饮食日）。
- 活动系数只反映日常活动，不含专门运动。
- 每日目标摄入 = 维持消耗 − 每周减重 × 32217 ÷ 7，且不低于 BMR 的 90%。`weekly_loss=0` 即维持。
- 未记饮食：净能量为 `null`，不是 0。
- 已有记录直接汇总，不要求用户确认完整；不能把未录入当没吃，也不按少量记录外推全天/长期减重。
- 改档案会按当前参数重算历史**估计消耗**；已保存的摄入、运动、体重不变。

这些都是估算，不是体脂秤或实验室测量。

---

## 前端要点

- 显示单位存在 `localStorage` 和 `display_unit` 偏好里。切换单位只改显示，草稿内部保持 kJ。
- 饮食草稿有稳定 ID；改克重按「每份基准」缩放，手填总能量不会被克重覆盖。运动改分钟时，MET 模式重算，手填模式保留。
- 草稿按日期存在本机（不含照片）。刷新后可恢复。
- 饮食页可点击照片投放区选择图片，也可把一张照片拖到饮食页任意内容区；拖入后预览，再与文字一起识别或随餐保存。
- 删除后可通过记录列表下方入口撤销，也可让 Agent 恢复 7 天内的误删记录。保存 / 复制带操作 ID，重试不会双写。
- 教练会话和消息保存在本机 SQLite。同一天可建多个会话，也可切换其他日期的会话；切换时记录日期会同步到会话日期。旧版浏览器本地聊天会在首次打开时迁移。
- 教练支持一次选择、拖入或粘贴多张图片，逐张预览和移除；浏览器先压缩，一次最多四张，再发送给已配置的视觉模型。后续追问会在当前与历史图片中合计带上最近四张；更早的图片只保留文字标记。备份含会话与聊天图片。
- 隐私说明与真实行为一致：记录在本机；使用 AI 时会发送本次输入、档案和近期记录到你配置的地址。

---

## 常见维护任务

- **新增常见食物**：在 `LOCAL_FOODS` 加 `(kcal, 蛋白, 碳水, 脂肪)` / 100g，需要进模型参考表时把名称加进 `_REFERENCE_NAMES`。
- **换默认模型**：改 `settings` 表默认值，或在设置里改。
- **调整提示词 / 输出格式**：`NUTRITION_SYSTEM` 与 `NUTRITION_SCHEMA` 必须同步。
- **加接口**：`Handler._api_get` / `_api_post`。
- **加表字段**：写 `ALTER TABLE` 迁移（`_add_column`），禁止删库。迁移前会走 SQLite backup API。

---

## 已知注意事项

- 不要同时起多个实例。启动前用 `/api/health` 识别是否已是本应用；其他网站占用端口会继续找空闲端口。
- 后台进程会被会话回收；长期运行请用独立窗口或 `Start-Process ... -WindowStyle Hidden`。
- 编码全部 UTF-8。PowerShell 5.1 管道传中文可能被转码，测试脚本请落文件再执行。
- 图片识别需开启视觉，并配置支持看图的模型。文本测试通过 ≠ 视觉通过。
- 没有把模块拆成多文件：仍由 `server.py` 一个入口启动。计算、校验、单位已收口到共用函数。

---

## 本地验证

```powershell
python -B -c "import ast,pathlib; ast.parse(pathlib.Path('server.py').read_text(encoding='utf-8'))"
node --check static/app.js
python -B tests/test_fitai.py
```

测试使用临时数据库和本地估算，不会读取真实健康记录，也不会消耗真实模型额度。
