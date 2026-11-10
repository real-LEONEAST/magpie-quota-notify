import { createNotifier } from "./runtime.mjs"
import { startSettingsService } from "./service.mjs"

export default async function quotaNotify(input, rawOptions = {}) {
  const notifier = await createNotifier(input, rawOptions)
  try {
    await startSettingsService(notifier, { port: Number(rawOptions.uiPort || 3479) })
  } catch (error) {
    // A CLI host can overlap the web host. Its monitor still shares the
    // same settings and transaction lock; only one host serves the page.
    if (error.code !== "EADDRINUSE") {
      await notifier.close()
      throw error
    }
  }
  return {} // No provider, no model, no prompt, and no usage-window ignition.
}