#!/usr/bin/env node
/**
 * 个人主页本地服务（零依赖，Node 18+）
 * ---------------------------------------------------------------
 * 作用有两个：
 *   1. 托管 index.html 等静态文件
 *   2. 提供 /api/remove-bg 代理接口，代替浏览器去调用 Replicate
 *
 * 为什么要后端？
 *   Replicate 的调用需要密钥。密钥一旦写进前端，任何人打开网页都能偷走。
 *   所以密钥只放在服务器的环境变量 REPLICATE_API_TOKEN 里，
 *   浏览器只把图片交给本站后端，由后端拿着密钥去请求 Replicate。
 *
 * 启动：
 *   Windows PowerShell :  $env:REPLICATE_API_TOKEN="r8_xxx"; node server.js
 *   Windows CMD        :  set REPLICATE_API_TOKEN=r8_xxx && node server.js
 *   macOS / Linux      :  export REPLICATE_API_TOKEN=r8_xxx && node server.js
 *   然后浏览器打开 http://localhost:5173
 *
 * 可选环境变量：
 *   PORT               监听端口，默认 5173
 *   HOST               监听地址，默认 127.0.0.1（只允许本机访问，更安全）
 *   REPLICATE_MODEL    模型，默认 lucataco/remove-bg
 *   MAX_UPLOAD_MB      单次上传体积上限，默认 12
 */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

/* 如果同目录下存在 .env，就先把里面的键值读进环境变量（保持零依赖）。
   已经存在的环境变量优先，不会被 .env 覆盖。 */
(function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  fs.readFileSync(envPath, "utf8").split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const eq = trimmed.indexOf("=");
    if (eq === -1) return;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    const quoted = (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);

    if (key && !(key in process.env)) process.env[key] = value;
  });

  console.log("[env] 已加载 .env");
})();

/* ------------------------------ 配置 ------------------------------ */

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || "127.0.0.1";

const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const MODEL = process.env.REPLICATE_MODEL || "lucataco/remove-bg";
// 可选：手动指定模型版本号（一般不用填，启动时自动解析最新版）
const MODEL_VERSION_ENV = process.env.REPLICATE_MODEL_VERSION || "";
const REPLICATE_API = "https://api.replicate.com/v1";

const MAX_UPLOAD_BYTES = (Number(process.env.MAX_UPLOAD_MB) || 12) * 1024 * 1024;
const SYNC_WAIT_SECONDS = 55;    // Prefer: wait —— 让接口同步等待这么久
const POLL_INTERVAL_MS = 1500;   // 超时后改为轮询的间隔
const POLL_TIMEOUT_MS = 90000;   // 轮询总超时

const ALLOWED_INPUT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/* ---------------------------- 小工具函数 ---------------------------- */

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 读取请求体，超过上限直接拒绝 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let stopped = false;

    req.on("data", (chunk) => {
      if (stopped) return;
      size += chunk.length;
      if (size > limit) {
        stopped = true;
        chunks.length = 0;
        const err = new Error(
          "图片超过 " + Math.round(limit / 1024 / 1024) + "MB 上限，请压缩后再试"
        );
        err.status = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (!stopped) resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (!stopped) reject(err);
    });
  });
}

/** 把 Replicate 返回的错误翻译成人能看懂的话 */
function pickDetail(data) {
  if (!data) return "";
  const raw = data.detail !== undefined ? data.detail
    : data.error !== undefined ? data.error
      : data.title;
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw);
  } catch (err) {
    return String(raw);
  }
}

function describeReplicateError(status, data) {
  const detail = pickDetail(data);
  const tail = detail ? "（" + detail + "）" : "";
  if (status === 401) return "Replicate 鉴权失败（401）：REPLICATE_API_TOKEN 无效或已失效，请检查环境变量";
  if (status === 402) return "Replicate 额度不足（402）：请到 replicate.com 充值或绑定支付方式";
  if (status === 403) return "Replicate 拒绝访问（403）：请确认账号有权调用该模型" + tail;
  if (status === 404) return "找不到资源（404）：模型版本可能已失效，可尝试在 .env 里设置 REPLICATE_MODEL_VERSION，或重启服务重新解析" + tail;
  if (status === 422) return "模型参数不合法（422）" + tail;
  if (status === 429) {
    // Replicate 的 429 正文会说明具体原因（例如余额不足 $5 时限流），
    // 这里保留原文更有助于排查，同时补一句中文引导。
    return "请求过于频繁（429）：已自动重试仍被限流，请等十几秒再试" + tail;
  }
  if (status >= 500) return "Replicate 服务暂时异常（" + status + "）：请稍后重试";
  return "Replicate 返回错误（" + status + "）" + tail;
}

/* ------------------------ Replicate 调用流程 ------------------------ */

/**
 * 解析模型的版本号。
 *
 * 为什么不用更省事的 POST /v1/models/{owner}/{name}/predictions？
 * 因为实测该"按模型名直接调用"的端点在部分模型上会返回 404
 * （同样的写法换成别的模型就正常），所以这里统一走
 * POST /v1/predictions 并显式带上 version —— 这条路径稳定可用。
 */
let cachedVersion = MODEL_VERSION_ENV || "";

async function resolveModelVersion() {
  if (cachedVersion) return cachedVersion;

  const res = await fetch(REPLICATE_API + "/models/" + MODEL, {
    headers: { Authorization: "Bearer " + REPLICATE_TOKEN },
  });
  const data = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(
      "无法读取模型信息（HTTP " + res.status + "）：请检查 REPLICATE_MODEL 是否为 " +
      MODEL + "，以及 token 是否有权限" + (pickDetail(data) ? "（" + pickDetail(data) + "）" : "")
    );
  }
  const version = data && data.latest_version && data.latest_version.id;
  if (!version) {
    throw new Error("模型 " + MODEL + " 没有可用版本，请确认模型已公开且有成功运行记录");
  }
  cachedVersion = version;
  return cachedVersion;
}

/** 创建一次预测（同步模式，最多等 SYNC_WAIT_SECONDS 秒） */
async function createPrediction(dataUri) {
  const version = await resolveModelVersion();

  // 免费/低额度账号限流较严（常见：6 次/分钟、突发 1 次），
  // 因此遇到 429 时按 retry_after 自动退避重试，而不是直接把错误甩给用户。
  const MAX_ATTEMPTS = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(REPLICATE_API + "/predictions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + REPLICATE_TOKEN,
        "Content-Type": "application/json",
        Prefer: "wait=" + SYNC_WAIT_SECONDS,
        "Cancel-After": "2m",
      },
      body: JSON.stringify({ version: version, input: { image: dataUri } }),
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error("Replicate 返回了非 JSON 响应（HTTP " + res.status + "）：" + text.slice(0, 200));
    }

    if (res.ok) return data;

    // 限流：能重试就再试，重试次数用尽才报错
    if (res.status === 429 && attempt < MAX_ATTEMPTS) {
      lastError = new Error(describeReplicateError(res.status, data));
      const waitMs = getRetryAfterMs(res, data, attempt);
      console.log("[remove-bg] 被限流，等待 " + Math.round(waitMs / 1000) + "s 后重试（第 " + attempt + "/" + MAX_ATTEMPTS + " 次）");
      await sleep(waitMs);
      continue;
    }

    throw new Error(describeReplicateError(res.status, data));
  }

  throw lastError || new Error("请求失败，请稍后重试");
}

/** 从响应头或响应体里取出建议的重试等待时间 */
function getRetryAfterMs(res, data, attempt) {
  const base = 11000 + (attempt - 1) * 5000; // 第一次 11s 起，按 6次/分钟 + burst=1 设计
  const headerSec = Number(res.headers.get("retry-after"));
  const bodySec = Number(data && data.retry_after);
  const recommended = (Number.isFinite(headerSec) && headerSec > 0) ? headerSec
    : (Number.isFinite(bodySec) && bodySec > 0) ? bodySec : 0;
  // 如果服务端已经告诉我们要等多久，就听它的；否则用默认值。都加一点抖动避免多个客户端同时重试。
  const jitter = Math.floor(Math.random() * 3000);
  return Math.max(recommended * 1000 + 1000, base) + jitter;
}

/** 同步模式没等到结果时，轮询到终态 */
async function waitForPrediction(prediction) {
  const terminal = new Set(["succeeded", "failed", "canceled"]);
  let pred = prediction;
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (!terminal.has(pred.status)) {
    if (Date.now() > deadline) throw new Error("处理超时，请稍后重试");
    await sleep(POLL_INTERVAL_MS);
    const res = await fetch(pred.urls.get, {
      headers: { Authorization: "Bearer " + REPLICATE_TOKEN },
    });
    if (!res.ok) throw new Error(describeReplicateError(res.status, await res.json().catch(() => null)));
    pred = await res.json();
  }
  return pred;
}

/** 模型输出可能直接是 URL 字符串，也可能是数组 */
function pickOutputUrl(output) {
  if (!output) return null;
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    for (let i = output.length - 1; i >= 0; i--) {
      if (typeof output[i] === "string") return output[i];
    }
    return null;
  }
  if (typeof output === "object" && typeof output.url === "string") return output.url;
  return null;
}

/** POST /api/remove-bg —— 请求体就是图片原始字节 */
async function handleRemoveBg(req, res) {
  if (!REPLICATE_TOKEN) {
    return sendJson(res, 500, {
      error: "服务端没有配置 REPLICATE_API_TOKEN。请设置好环境变量后重启 node server.js（详见 README.md）",
    });
  }

  let buffer;
  try {
    buffer = await readBody(req, MAX_UPLOAD_BYTES);
  } catch (err) {
    return sendJson(res, err.status || 400, { error: err.message || "读取上传内容失败" });
  }

  if (!buffer || buffer.length === 0) {
    return sendJson(res, 400, { error: "没有收到图片数据" });
  }

  const rawType = String(req.headers["content-type"] || "image/jpeg").split(";")[0].trim().toLowerCase();
  const inputType = ALLOWED_INPUT_TYPES.has(rawType) ? rawType : "image/jpeg";
  const dataUri = "data:" + inputType + ";base64," + buffer.toString("base64");

  console.log("[remove-bg] 收到图片 " + (buffer.length / 1024).toFixed(0) + "KB，开始提交 Replicate…");

  try {
    const created = await createPrediction(dataUri);
    const pred = await waitForPrediction(created);

    if (pred.status !== "succeeded") {
      const why = pred.error ? ": " + pred.error : "";
      throw new Error("模型处理未成功（状态 " + pred.status + "）" + why);
    }

    const outputUrl = pickOutputUrl(pred.output);
    if (!outputUrl) throw new Error("模型没有返回图片结果");

    // 由服务器把结果图取回来再转发给浏览器，避免跨域问题
    const imageRes = await fetch(outputUrl);
    if (!imageRes.ok) throw new Error("下载结果图片失败（HTTP " + imageRes.status + "）");
    const imageBuffer = Buffer.from(await imageRes.arrayBuffer());

    console.log("[remove-bg] 完成，返回 " + (imageBuffer.length / 1024).toFixed(0) + "KB");

    res.writeHead(200, {
      "Content-Type": imageRes.headers.get("content-type") || "image/png",
      "Content-Length": imageBuffer.length,
      "Cache-Control": "no-store",
      "X-Prediction-Id": pred.id || "",
    });
    res.end(imageBuffer);
  } catch (err) {
    console.error("[remove-bg] 失败：" + err.message);
    if (!res.headersSent) sendJson(res, 502, { error: err.message || "处理失败，请稍后重试" });
  }
}

/* ---------------------------- 静态文件 ---------------------------- */

const ROOT_RESOLVED = path.resolve(ROOT);

function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent((req.url || "/").split("?")[0]);
  } catch (err) {
    return sendJson(res, 400, { error: "Bad request" });
  }

  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(ROOT_RESOLVED, rel);

  // 防止越权读取目录外文件
  if (resolved !== ROOT_RESOLVED && !resolved.startsWith(ROOT_RESOLVED + path.sep)) {
    return sendJson(res, 403, { error: "Forbidden" });
  }
  // 不对外暴露隐藏文件（例如 .env）
  if (path.basename(resolved).startsWith(".")) {
    return sendJson(res, 404, { error: "Not found" });
  }

  fs.stat(resolved, (err, stat) => {
    if (err || !stat.isFile()) return sendJson(res, 404, { error: "Not found" });

    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-store",
    });
    fs.createReadStream(resolved).pipe(res);
  });
}

/* ------------------------------ 路由 ------------------------------ */

const server = http.createServer((req, res) => {
  const pathname = (req.url || "/").split("?")[0];

  if (req.method === "POST" && pathname === "/api/remove-bg") {
    return handleRemoveBg(req, res);
  }

  if (req.method === "GET" && pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      model: MODEL,
      version: cachedVersion || null,
      tokenConfigured: Boolean(REPLICATE_TOKEN),
      maxUploadMB: Math.round(MAX_UPLOAD_BYTES / 1024 / 1024),
    });
  }

  if (req.method === "GET" || req.method === "HEAD") {
    return serveStatic(req, res);
  }

  sendJson(res, 405, { error: "Method not allowed" });
});

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("  个人主页已启动 →  http://" + HOST + ":" + PORT);
  console.log("  模型：" + MODEL);
  if (REPLICATE_TOKEN) {
    console.log("  REPLICATE_API_TOKEN：已读取（长度 " + REPLICATE_TOKEN.length + "）");
    // 启动时就把模型版本解析好：早发现模型名/权限问题，别等用户传完图才报错
    resolveModelVersion()
      .then((v) => console.log("  模型版本：" + v.slice(0, 12) + "…（已就绪）"))
      .catch((err) => console.log("  ⚠ 模型版本解析失败：" + err.message));
  } else {
    console.log("  REPLICATE_API_TOKEN：未设置 ⚠");
    console.log("  → 天气、学习记录都能正常看，但「去除背景」会报错。");
    console.log("  → 设置方法见 README.md，然后重新运行 node server.js。");
  }
  console.log("");
});
