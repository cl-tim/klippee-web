import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { bootSharedWorker, db, dispatch, disposeSharedWorker, insertPrivatePackage,
  SESSION_TOKEN, WORKER_ORIGIN } from "./helpers.mjs";

const headers = { cookie: `__Host-klippee_session=${SESSION_TOKEN}`, origin: WORKER_ORIGIN, "content-type": "application/json" };
const definition = name => ({ name, label: name, description: "Secret declaration fixture", type: "text", required: false, secret: true });
const values = { private_setting: "private-only", public_setting: "public-only", foreign_setting: "owner-visible", alias_setting: "alias-visible", normal: 12 };

describe("Secret declaration binding reads", () => {
  before(async () => {
    await bootSharedWorker();
    const files = [{ path: "printer.cfg", content: "[printer]\nkinematics: cartesian\n", public: false, role: "printer" }];
    await insertPrivatePackage("shared-binding", files, [], [definition("private_setting")]);
    await insertPrivatePackage("shared-binding", files, [], [definition("foreign_setting")], [], "user_2");
    const base = JSON.parse((await db.prepare("SELECT package_json FROM private_packages LIMIT 1").first()).package_json);
    for (const [slug, name, variable] of [
      ["shared-binding", "Real public binding", "public_setting"],
      ["canonical-public-slug", "display-only-name", "alias_setting"],
    ]) {
      await db.prepare(`INSERT INTO public_packages
        (id,user_id,source_package_id,slug,name,title,package_json,created_at,updated_at,published_at)
        VALUES (?,'user_2',?,?,?,?,?,'2000-01-01','2000-01-01','2000-01-01')`)
        .bind(`public-${slug}`, slug, slug, name, name, JSON.stringify({ ...base, variables: [definition(variable)] })).run();
    }
    // More than D1's per-statement parameter budget, plus duplicate/invalid
    // legacy bindings: the lookup must keep the IDs in bound JSON arrays.
    const bindings = [...Array.from({ length: 400 }, (_, i) => `missing-${i}`), "shared-binding", "shared-binding", "display-only-name", "", null, 42];
    await db.prepare(`INSERT INTO printers (id,user_id,name,package_ids_json,variable_values_json,created_at,updated_at)
      VALUES ('binding-printer','user_1','Binding fixture',?,?,'2000-01-01','2000-01-01')`)
      .bind(JSON.stringify(bindings), JSON.stringify(values)).run();
  });
  after(disposeSharedWorker);

  async function printer() {
    const response = await dispatch("/api/printers", { headers });
    assert.equal(response.status, 200);
    return (await response.json()).printers.find(row => row.id === "binding-printer");
  }

  it("unions owned private and slug-bound public declarations without foreign/private or display-name matches", async () => {
    assert.deepEqual((await printer()).variableValues, { foreign_setting: "owner-visible", alias_setting: "alias-visible", normal: 12 });
  });

  it("uses the same declarations when accepting or scrubbing per-name variable writes", async () => {
    for (const [name, stored] of [["private_setting", false], ["public_setting", false], ["foreign_setting", true], ["alias_setting", true]]) {
      const response = await dispatch(`/api/printers/binding-printer/variables/${name}`, {
        method: "PATCH", headers, body: JSON.stringify({ value: "updated" }),
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.stored, stored, name);
      assert.equal(Object.hasOwn(result.printer.variableValues, name), stored, name);
    }
    assert.deepEqual((await printer()).variableValues, { foreign_setting: "updated", alias_setting: "updated", normal: 12 });
  });

  it("handles an empty binding list without stale declarations", async () => {
    await db.prepare("UPDATE printers SET package_ids_json = '[]', variable_values_json = ? WHERE id = 'binding-printer'")
      .bind(JSON.stringify(values)).run();
    assert.deepEqual((await printer()).variableValues, values);
  });
});
