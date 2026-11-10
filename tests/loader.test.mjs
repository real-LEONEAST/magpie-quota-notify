import test from "node:test"
import assert from "node:assert/strict"
import * as entry from "../index.mjs"

test("Magpie v0.1.3336 sees exactly one plugin initializer", () => {
  // This matches the host's entry rule, rather than importing only default
  // as the original lifecycle test did. Helper exports are initializers too.
  const initializers = entry.default && typeof entry.default === "object"
    ? [entry.default.server].filter((value) => typeof value === "function")
    : [...new Set(Object.values(entry))].filter((value) => typeof value === "function")
  assert.equal(initializers.length, 1)
  assert.equal(initializers[0], entry.default)
})
