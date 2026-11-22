import { writeDb } from "../db";
import { json, readJsonBody } from "../http";
import { PrivatePackageRepository } from "../repositories/PrivatePackageRepository";
import { withUser } from "../route";

export const listPrivatePackagesForManagement = withUser(async (_request, env, user) => {
  return json({ packages: await PrivatePackageRepository.listForManagement(writeDb(env), user.id) });
});

export const deletePrivatePackage = withUser(async (request, env, user, params) => {
  const db = writeDb(env);
  const existing = await PrivatePackageRepository.getOwned(db, user.id, params.id);
  if (!existing) return json({ error: "Private package not found" }, { status: 404 });
  const body = await readJsonBody<{ updatedAt?: unknown } | null>(request, 4_096);
  if (!body.ok) return body.response;
  if (typeof body.value?.updatedAt !== "string" || !body.value.updatedAt) {
    return json({ error: "Deletion requires the private package's updatedAt" }, { status: 400 });
  }
  const deleted = await PrivatePackageRepository.deleteUnused(db, user.id, params.id, {
    updatedAt: body.value.updatedAt, packageJson: existing.package_json,
  });
  if (!deleted.length) {
    if (!await PrivatePackageRepository.getOwned(db, user.id, params.id)) {
      return json({ error: "Private package not found" }, { status: 404 });
    }
    return json({ code: "private_package_delete_conflict",
      error: "This private package changed or is bound to a printer in Klippee. Refresh the list and unbind it before deleting.",
    }, { status: 409 });
  }
  // Source-FK cascades remove private references. Public snapshots, companion
  // assets, file bodies, leases and cumulative claims have their own lifecycle.
  return json({ ok: true, deletedPackageId: params.id });
});
