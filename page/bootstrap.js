async function openSettings() {
  try {
    await magpie.ready
    if (!magpie.service) throw new Error("请从 Magpie 网页版打开此页面，并确认主机已加载插件。")
    location.replace(magpie.service.endsWith("/") ? magpie.service : magpie.service + "/")
  } catch (error) {
    document.querySelector("#message").textContent = error.message || "设置页暂时无法打开，请重新打开插件页面。"
  }
}
openSettings()
