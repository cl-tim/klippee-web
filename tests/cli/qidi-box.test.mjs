import assert from "node:assert/strict";
import { it } from "node:test";
import { fixturePath, installer, python, run } from "./helpers.mjs";

it("queries the QIDI Box reset reason through a mocked, non-resetting transport", async () => {
  const result = await run(python, [fixturePath("qidi_box_reset_reason.py"), installer]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
