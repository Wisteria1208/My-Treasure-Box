# 刘成荫 · 个人主页

一个纯前端的响应式个人主页，外加一个由本地 Node 服务代理的「一键去除图片背景」小工具。

页面分三屏：

| 屏幕 | 内容 |
| --- | --- |
| 第一屏 | 关于我：圆形头像、昵称、一句话介绍、兴趣爱好、学习目标 |
| 第二屏 | 我的学习记录：可筛选的时间线，数据来自一个 JS 数组，随时可加 |
| 第三屏 | 一键去除图片背景：拖拽上传、原图/结果对比、结果可下载 |

右上角常驻**北京实时天气**（Open-Meteo 免费接口，无需 Key），支持浅色/深色主题切换，手机与电脑都能正常浏览。

---

## 一、目录结构

```
0929文件夹/
├── index.html          # 整个页面（HTML + CSS + JS 都在这一个文件里）
├── server.js           # 本地服务：托管静态文件 + 代理 Replicate 接口
├── .env.example        # 环境变量模板，复制成 .env 后填自己的 token
├── .env                # 你的密钥（自己创建，不要外传）
├── 白底证件照.jpg       # 头像
├── 新媒体研究院26级实务—刘成荫  简历.pdf
├── README.md
└── .workbuddy/         # 项目记忆与辅助脚本，不影响页面
    ├── verify.js       # 页面逻辑自检（44 项断言），改完页面可重跑
    ├── pngstat.js      # 解码 PNG 统计透明像素，验证抠图是否真的生效
    └── 抠图效果验证-透明背景.png  # 真实抠图测试结果示例
```

---

## 二、快速开始

### 0. 环境要求

- **Node.js 18 或更高**（用来跑 `server.js`，需要 Node 内置的 `fetch`）
  检查：`node -v`

### 1. 拿到 Replicate 密钥

到 <https://replicate.com/account/api-tokens> 创建一个 token，形如 `r8_xxxxxxxx`。

### 2. 把密钥放进环境变量（二选一）

**方式 A：用 .env 文件（推荐，最省事）**

```bash
# 把模板复制成 .env
copy .env.example .env        # Windows
cp .env.example .env          # macOS / Linux
```

然后打开 `.env`，把这一行改成你自己的 token：

```
REPLICATE_API_TOKEN=r8_你的真实token
```

`server.js` 启动时会自动读取同目录下的 `.env`。

**方式 B：直接设置环境变量**

```powershell
# Windows PowerShell
$env:REPLICATE_API_TOKEN="r8_你的真实token"; node server.js
```

```cmd
:: Windows CMD
set REPLICATE_API_TOKEN=r8_你的真实token && node server.js
```

```bash
# macOS / Linux
export REPLICATE_API_TOKEN=r8_你的真实token && node server.js
```

> **密钥不会出现在前端代码里。** 浏览器只把图片发给本站后端，由后端带着密钥去请求 Replicate。

### 3. 启动

```bash
node server.js
```

看到下面的输出就成功了：

```
  个人主页已启动 →  http://127.0.0.1:5173
  模型：lucataco/remove-bg
  REPLICATE_API_TOKEN：已读取（长度 40）
  模型版本：95fcc2a26d38…（已就绪）
```

### 4. 打开浏览器

访问 **<http://127.0.0.1:5173>**

> ⚠️ **不要直接双击 `index.html`**，也不要依赖 IDE/编辑器的静态文件预览。`index.html` 里的「去除背景」需要调用 `/api/remove-bg`，这个接口只在 `node server.js` 启动的服务里才有；从静态预览或 `file://` 打开时，调用会返回 **404**，页面上会显示「当前页面是静态预览，请通过本地服务打开」的提示。
>
> 所以正确的打开方式永远是：先启动服务，再访问 `http://127.0.0.1:5173`（改了 PORT 就换对应端口）。

---

## 三、环境变量一览

服务启动时会读取以下变量（`.env` 文件或系统环境变量均可）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `REPLICATE_API_TOKEN` | 无 | **必填**，Replicate 密钥，抠图功能依赖它 |
| `PORT` | `5173` | 监听端口，被占用就换一个 |
| `HOST` | `127.0.0.1` | 监听地址，默认只允许本机访问 |
| `REPLICATE_MODEL` | `lucataco/remove-bg` | 使用的模型 |
| `REPLICATE_MODEL_VERSION` | 自动解析 | 手动固定模型版本号；一般不用填 |
| `MAX_UPLOAD_MB` | `12` | 单次上传体积上限（MB） |

---

## 四、「去除背景」是怎么实现的

### 完整链路

```
浏览器                          本站后端 (server.js)              Replicate
  │                                   │                              │
  │ 1. 选图 / 拖拽 / 粘贴              │                              │
  │ 2. canvas 压缩到长边 1600px        │                              │
  │ 3. POST /api/remove-bg ──────────► │                              │
  │    (请求体 = 图片原始字节)          │ 4. 转成 base64 data URI        │
  │                                   │ 5. 启动时自动解析模型最新版本   │
  │                                   │ 6. POST /v1/predictions ──────►│
  │                                   │    {version, input}           │
  │                                   │    Prefer: wait=55            │
  │                                   │ ◄──── 返回透明 PNG 的 URL ─────│
  │                                   │ 7. 服务器把结果图下载回来        │
  │ ◄── 8. 返回 image/png ────────── │                              │
  │ 9. 显示在棋盘格上 + 可下载          │                              │
```

### 用到的模型信息

| 项目 | 值 |
| --- | --- |
| 模型 | `lucataco/remove-bg`（tracer_b7 实现，约 2 秒完成） |
| 文档 | <https://replicate.com/lucataco/remove-bg/api> |
| 创建预测 | `POST https://api.replicate.com/v1/predictions`（带显式 `version`） |
| 鉴权 | 请求头 `Authorization: Bearer $REPLICATE_API_TOKEN` |
| 输入 | `{ "version": "模型版本号", "input": { "image": "<图片URL 或 data URI>" } }` |
| 输出 | 透明背景 PNG 的 URL |
| 固定版本（可选） | `95fcc2a26d3899cd6c2691c900465aaeff466285a65c14638cc5f36f34befaf1` |

### 几个关键取舍

- **为什么用同步模式？** 请求时带 `Prefer: wait=55`，Replicate 会把连接挂起最多 55 秒，算完直接返回结果，省掉一次轮询。如果 55 秒还没算完，代码会自动改成每 1.5 秒轮询一次，最多等 90 秒。
- **为什么前端要先压缩？** Replicate 官方建议 data URI 只用在小文件（< 1MB）上。所以在浏览器里先把长边压到 1600px 再上传，既控制体积也更快、更省额度。尺寸和体积本来就合适的小图会原样上传，不做二次编码，保留画质。
- **为什么结果要经过服务器中转？** 避免浏览器直接访问 Replicate 的结果域名时的跨域问题，同时保证结果图不会暴露成临时外链。
- **防跑飞：** 创建预测时带了 `Cancel-After: 2m`，万一任务卡住会在 2 分钟后自动取消，避免白扣额度。

---

## 五、接口说明

### `GET /api/health`

给前端探测服务状态用。

```json
{ "ok": true, "model": "lucataco/remove-bg", "version": "95fcc2a26d3899cd6c2691c900465aaeff466285a65c14638cc5f36f34befaf1", "tokenConfigured": true, "maxUploadMB": 12 }
```

### `POST /api/remove-bg`

- 请求体：图片**原始字节**（不是表单、不是 base64），把 `Content-Type` 设成 `image/jpeg`、`image/png` 或 `image/webp`
- 成功：`200`，响应体就是处理好的 `image/png`，附带 `X-Prediction-Id` 响应头
- 失败：`4xx/5xx`，响应体是 `{ "error": "人能看懂的原因" }`

用 curl 试一下（把图片路径换成你自己的）：

```bash
curl -X POST http://127.0.0.1:5173/api/remove-bg \
  -H "Content-Type: image/jpeg" \
  --data-binary "@/path/to/photo.jpg" \
  --output result.png
```

---

## 六、常见问题

**Q：页面提示「未连接后端服务，请先运行 node server.js」？**
没启后端，或者你不是通过 `http://127.0.0.1:5173` 打开的。注意：直接双击 HTML、用编辑器静态预览、或用 `file://` 协议打开，都会报 404。必须先启动服务，再用服务地址访问。

**Q：提示「后端已启动，但未配置 REPLICATE_API_TOKEN」？**
环境变量没读到。检查 `.env` 文件是不是放在了和 `server.js` 同一个目录、里面那行是不是 `REPLICATE_API_TOKEN=r8_...`（不要加引号、不要有空格）。改完要**重启** `node server.js`。

**Q：报 401？**
token 错了或失效了。去 <https://replicate.com/account/api-tokens> 重新建一个。

**Q：报 402 或提示额度不足？**
Replicate 是按量计费的，新账号有少量免费额度，用完需要充值。这个模型很便宜（单张通常不到 1 分钱），但请自己留意用量。

**Q：报 429 请求过于频繁？**
短时间内发太多请求了。账号额度少于 $5 时，Replicate 会限流到「6 次/分钟、突发 1 次」；页面会自动等待并提示你稍后重试，想连续处理多张建议错开 10-15 秒。

**Q：图片太大上传失败？**
默认单次上限 12MB。可以调大 `MAX_UPLOAD_MB`，但更推荐先自己压缩一下。

**Q：端口 5173 被占用？**
换一个：`node server.js` 前设置 `PORT`，例如 `PORT=8080 node server.js`。

**Q：手机上能用吗？**
能用。页面是响应式的，手机上原图和结果会改成上下排列。但后端默认只监听 `127.0.0.1`，手机要访问的话，需要把 `HOST` 设成 `0.0.0.0` 并用电脑的局域网 IP 访问（注意这样同一个局域网内的人也能用到你的接口）。

**Q：抠出来的边缘不够干净？**
试试光线更好、主体和背景对比更明显的原图。头发、毛绒这类细节可以再用修图软件微调。

---

## 七、想改点什么

| 想改的东西 | 去哪里改 |
| --- | --- |
| 头像 | `index.html` 里搜索 `头像图片`，改 `<img src="...">` 的文件名 |
| 颜色 / 主题 | `index.html` 的 `<style>` 开头 `:root` 里的 CSS 变量 |
| 昵称、介绍、兴趣、目标 | 第一屏 `#about` 里的 HTML 文字 |
| 学习记录 | 页面底部 JS 里搜索 `学习记录数组`，复制一条对象加到数组里 |
| 天气城市 | 页面底部 JS 里搜索 `WEATHER_CITY`，改经纬度（上海是 `31.2304, 121.4737`） |
| 上传压缩尺寸 | 页面底部 JS 里搜索 `UPLOAD_MAX_SIDE`，默认 1600 |
| 端口 / 模型 / 上传上限 | `.env` 文件，或对应的环境变量 |

---

## 八、安全与成本提醒

- 密钥只存在于服务端环境变量，前端任何地方都没有 token。
- 后端默认只监听 `127.0.0.1`，外网访问不到，也不会把 `.env` 这类隐藏文件当静态资源暴露出去。
- 不要把 `.env` 提交到 Git 或发给别人；万一泄露了，立刻去 Replicate 后台吊销重建。
- 抠图功能按调用次数计费，请自行留意用量，别把接口开在公网上让人刷。
