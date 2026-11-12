const DEFAULT_UI_PORT = 3479

async function openSettings() {
  try {
    await magpie.ready
    let service = magpie.service
    if (!service) {
      // The native window and the Bun service run on the same computer.
      // A browser without a service proxy must never use its own loopback.
      if (location.hostname !== "wails.localhost" && location.protocol !== "wails:") {
        throw new Error("Magpie 未提供设置服务地址，请确认宿主支持插件页面代理。")
      }
      const options = await magpie.options.get()
      const port = Number(options?.uiPort || DEFAULT_UI_PORT)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("设置服务端口无效。")
      service = `http://127.0.0.1:${port}/`
    }
    location.replace(service.endsWith("/") ? service : service + "/")
  } catch (error) {
    document.querySelector("#message").textContent = error.message || "设置页暂时无法打开，请重新打开插件页面。"
  }
}
openSettings()
