import { createServer } from "node:http"
import { randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { problem } from "./settings.mjs"

const PAGE_DIRECTORY = fileURLToPath(new URL("./page/", import.meta.url))
const BODY_LIMIT = 64 * 1024
const POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
const ASSETS = { "/app.js": "text/javascript; charset=utf-8", "/style.css": "text/css; charset=utf-8", "/controls.css": "text/css; charset=utf-8" }

async function readBody(request) {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw problem("请使用 JSON 请求", 415)
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > BODY_LIMIT) throw problem("设置内容过大", 413)
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) }
  catch { throw problem("设置内容无法读取") }
}

// Magpie's authenticated page-service proxy supplies the browser URL.
// The service itself only listens on loopback; it needs no Docker mapping.
export async function startSettingsService(notifier, { port = 3479, demo = false } = {}) {
  const token = randomBytes(32).toString("hex")
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store")
    response.setHeader("X-Content-Type-Options", "nosniff")
    response.setHeader("Referrer-Policy", "no-referrer")
    response.setHeader("Content-Security-Policy", POLICY)
    const json = (status, data) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
      response.end(JSON.stringify(data))
    }
    try {
      const localPort = server.address().port
      const hosts = [`127.0.0.1:${localPort}`, `localhost:${localPort}`]
      if (!hosts.includes(request.headers.host)) throw problem("访问地址无效", 403)
      const pathname = new URL(request.url, `http://127.0.0.1:${localPort}`).pathname
      if (pathname.startsWith("/api/")) {
        const origin = request.headers.origin
        if (origin && origin !== "null" && !hosts.some((host) => origin === `http://${host}`)) throw problem("请求来源无效", 403)
        if (origin) {
          response.setHeader("Access-Control-Allow-Origin", origin)
          response.setHeader("Vary", "Origin")
        }
        if (request.method === "OPTIONS") {
          response.writeHead(204, {
            "Access-Control-Allow-Methods": "GET, POST",
            "Access-Control-Allow-Headers": "Content-Type, X-Quota-Token",
          })
          return response.end()
        }
        if (request.headers["x-quota-token"] !== token) throw problem("页面已过期，请重新打开", 403)
        if (request.method === "GET" && pathname === "/api/config") return json(200, notifier.readConfig())
        if (request.method === "GET" && pathname === "/api/status") return json(200, { ...await notifier.status(), demo })
        if (request.method === "POST" && pathname === "/api/config") return json(200, notifier.saveConfig(await readBody(request)))
        if (request.method === "POST" && pathname === "/api/test") return json(202, notifier.requestTest(await readBody(request)))
        throw problem("接口不存在", 404)
      }
      // Do not grant CORS access to HTML: an opaque external frame must
      // never read the per-process token embedded in the settings page.
      if (!["GET", "HEAD"].includes(request.method)) throw problem("请求方式无效", 405)
      let body
      let type
      if (["/", "/ui", "/ui.html"].includes(pathname)) {
        body = (await readFile(join(PAGE_DIRECTORY, "ui.html"), "utf8")).replace("{{QUOTA_TOKEN}}", token)
        type = "text/html; charset=utf-8"
      } else if (Object.hasOwn(ASSETS, pathname)) {
        body = await readFile(join(PAGE_DIRECTORY, pathname.slice(1)))
        type = ASSETS[pathname]
      } else throw problem("页面不存在", 404)
      response.writeHead(200, { "Content-Type": type })
      response.end(request.method === "HEAD" ? undefined : body)
    } catch (error) {
      json(error.status || 500, { error: error.status ? error.message : "服务暂时无法处理请求" })
      if (!error.status) console.error(`[quota-notify] 设置服务出错：${error.name}`)
    }
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", resolve)
  })
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}
