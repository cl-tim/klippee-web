import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { unzipSync } from "fflate";
import { Miniflare } from "./miniflare.mjs";
import {
  SECOND_SESSION_TOKEN,
  SESSION_SECRET,
  SESSION_TOKEN,
  WORKER_ORIGIN,
  armPublicListingPatchHook,
  bootSharedWorker,
  db,
  dispatch,
  disposeSharedWorker,
  insertPrivatePackage,
  mf,
  publishStoredPackage,
} from "./helpers.mjs";

describe("worker API smoke: packages-public", () => {
  before(async () => {
    await bootSharedWorker();
  });

  after(async () => {
    await disposeSharedWorker();
  });

  it("serves the package catalog without requiring a session", async () => {
    const response = await dispatch("/api/packages");
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(Array.isArray(body.packages), true);
  });

  it("lists the catalog as summaries (no file contents) and hydrates a full package by id", async () => {
    const published = await publishStoredPackage();

    // The catalog summary carries file paths/roles but empty contents (no blob fetch).
    const list = await dispatch("/api/packages");
    const listBody = await list.json();
    const summary = listBody.packages.find((pkg) => pkg.id === published.slug);
    assert.notEqual(summary, undefined);
    assert.equal(summary.publicSlug, published.slug);
    assert.equal(summary.sourcePackageId, "package_1");
    assert.equal(summary.files.length > 0, true);
    assert.equal(summary.files.every((file) => file.content === ""), true);
    assert.equal(summary.files.some((file) => file.path === "printer.cfg"), true);

    // Opening the package by id returns the full file contents.
    const full = await dispatch(`/api/packages/${published.slug}`);
    const fullBody = await full.json();
    assert.equal(full.status, 200);
    assert.match(fullBody.package.files.find((file) => file.path === "printer.cfg").content, /include macros/);
  });

  it("filters public packages by the indexed tag, printer, and text facets", async () => {
    // package_1 publishes with tags ["public", "fixture"], printer "Bench printer",
    // hardware ["cartesian"]. Bundled packages do not carry the "fixture" tag or the
    // "Bench printer" name, so they are safe discriminators.
    const published = await publishStoredPackage();

    const hasPackage1 = async (query) => {
      const response = await dispatch(`/api/packages${query}`);
      assert.equal(response.status, 200);
      const body = await response.json();
      return body.packages.some((pkg) => pkg.id === published.slug);
    };

    // Tag facet (exact membership).
    assert.equal(await hasPackage1("?tag=fixture"), true);
    assert.equal(await hasPackage1("?tag=does-not-exist"), false);

    // Printer facet (case-insensitive exact match).
    assert.equal(await hasPackage1("?printer=Bench%20printer"), true);
    assert.equal(await hasPackage1("?printer=bench%20printer"), true);
    assert.equal(await hasPackage1("?printer=Nonexistent%20Printer"), false);

    // Free-text search across title/description/printer/hardware/tags, all terms must match.
    assert.equal(await hasPackage1("?q=bench"), true);
    assert.equal(await hasPackage1("?q=Bench%20cartesian"), true);
    assert.equal(await hasPackage1("?q=zzgibberish"), false);
  });

  it("caches only the unfiltered public package catalog", async () => {
    const packageId = "cache-package";
    const packageBody = {
      description: "Cache fixture package",
      files: [{ content: "[printer]\nkinematics: cartesian\n", path: "printer.cfg", public: false, role: "printer" }],
      hardware: ["cartesian"],
      id: packageId,
      name: packageId,
      printer: "Cache printer",
      tags: ["cache-fixture"],
      title: "Cache Fixture",
      variables: [],
      version: "2026.05.23",
      warnings: [],
    };
    const save = await dispatch("/api/private-packages", {
      body: JSON.stringify({ package: packageBody }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    assert.equal(save.status, 201);

    const publish = await dispatch("/api/public-packages", {
      body: JSON.stringify({ packageId }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const published = await publish.json();
    assert.equal(publish.status, 201);

    const first = await dispatch("/api/packages");
    const firstBody = await first.json();
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("x-klippee-cache"), "MISS");
    assert.equal(firstBody.packages.some((pkg) => pkg.id === published.slug), true);

    await db.prepare("DELETE FROM public_packages WHERE slug = ?")
      .bind(published.slug)
      .run();

    const second = await dispatch("/api/packages");
    const secondBody = await second.json();
    assert.equal(second.status, 200);
    assert.equal(second.headers.get("x-klippee-cache"), "HIT");
    assert.equal(secondBody.packages.some((pkg) => pkg.id === published.slug), true);

    const filtered = await dispatch("/api/packages?q=cache-fixture");
    const filteredBody = await filtered.json();
    assert.equal(filtered.status, 200);
    assert.equal(filtered.headers.get("x-klippee-cache"), "MISS");
    assert.equal(filteredBody.packages.some((pkg) => pkg.id === published.slug), false);
  });

  it("requires owner approval before printer-applied files change a public listing", async () => {
    const packageId = "live-registry-config";
    await insertPrivatePackage(packageId, [{
      content: "[printer]\nkinematics: none\n",
      path: "printer.cfg",
      public: false,
      role: "printer",
    }]);

    const createRepositoryResponse = await dispatch("/api/repos", {
      body: JSON.stringify({
        files: [{
          content: "[printer]\nkinematics: corexy\nmax_velocity: 200\n",
          path: "printer.cfg",
          public: false,
          role: "printer",
        }, {
          content: "runtime_secret: keep-private\n",
          path: "saved_variables.cfg",
          public: false,
          role: "include",
        }],
        message: "Initial desired configuration",
        name: "live-registry-config",
        title: "Live registry config",
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const createdRepository = await createRepositoryResponse.json();
    assert.equal(createRepositoryResponse.status, 201);

    const printerId = "printer_live_registry";
    const createPrinterResponse = await dispatch("/api/printers", {
      body: JSON.stringify({
        printer: {
          id: printerId,
          name: "Live registry printer",
          repositoryId: createdRepository.repository.id,
        },
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    assert.equal(createPrinterResponse.status, 201);

    const noCandidateResponse = await dispatch(`/api/printers/${printerId}/publication-candidate`, {
      headers: { cookie: `__Host-klippee_session=${SESSION_TOKEN}` },
    });
    const noCandidateBody = await noCandidateResponse.json();
    assert.equal(noCandidateResponse.status, 200, JSON.stringify(noCandidateBody));
    assert.equal(noCandidateBody.candidate, null);

    const createTokenResponse = await dispatch(`/api/repos/${createdRepository.repository.id}/sync-tokens`, {
      body: JSON.stringify({
        name: "Live registry printer token",
        printerId,
        scopes: ["repo:read", "repo:write"],
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const token = await createTokenResponse.json();
    assert.equal(createTokenResponse.status, 201);

    const applyInitialResponse = await dispatch(`/api/sync/repos/${createdRepository.repository.id}/applied`, {
      body: JSON.stringify({ versionNumber: 1 }),
      headers: {
        authorization: `Bearer ${token.token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    assert.equal(applyInitialResponse.status, 200);

    const anonymousCandidateResponse = await dispatch(`/api/printers/${printerId}/publication-candidate`);
    assert.equal(anonymousCandidateResponse.status, 401);
    const otherOwnerCandidateResponse = await dispatch(`/api/printers/${printerId}/publication-candidate`, {
      headers: { cookie: `__Host-klippee_session=${SECOND_SESSION_TOKEN}` },
    });
    assert.equal(otherOwnerCandidateResponse.status, 404);
    const initialCandidateResponse = await dispatch(`/api/printers/${printerId}/publication-candidate`, {
      headers: { cookie: `__Host-klippee_session=${SESSION_TOKEN}` },
    });
    const initialCandidateBody = await initialCandidateResponse.json();
    assert.equal(initialCandidateResponse.status, 200);
    assert.equal(typeof initialCandidateBody.candidate.appliedAt, "string");
    assert.equal(initialCandidateBody.candidate.repositoryId, createdRepository.repository.id);
    assert.equal(initialCandidateBody.candidate.versionNumber, 1);
    assert.equal(typeof initialCandidateBody.candidate.versionId, "string");
    assert.deepEqual(initialCandidateBody.candidate.files.map((file) => file.path), ["printer.cfg"]);
    assert.equal(initialCandidateBody.candidate.files[0].public, true);
    assert.match(initialCandidateBody.candidate.files[0].content, /max_velocity: 200/);

    const missingExpectedVersionResponse = await dispatch("/api/public-packages", {
      body: JSON.stringify({
        acknowledgeSafetyWarnings: true,
        packageId,
        printerId,
        repositoryId: createdRepository.repository.id,
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    assert.equal(missingExpectedVersionResponse.status, 400);
    assert.match((await missingExpectedVersionResponse.json()).error, /expected applied version id is required/i);

    const oversizedExpectedVersionResponse = await dispatch("/api/public-packages", {
      body: JSON.stringify({
        acknowledgeSafetyWarnings: true,
        expectedAppliedVersionId: "v".repeat(129),
        packageId,
        printerId,
        repositoryId: createdRepository.repository.id,
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    assert.equal(oversizedExpectedVersionResponse.status, 400);
    assert.match((await oversizedExpectedVersionResponse.json()).error, /at most 128 characters/i);

    const publishResponse = await dispatch("/api/public-packages", {
      body: JSON.stringify({
        acknowledgeSafetyWarnings: true,
        expectedAppliedVersionId: initialCandidateBody.candidate.versionId,
        packageId,
        printerId,
        repositoryId: createdRepository.repository.id,
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const published = await publishResponse.json();
    assert.equal(publishResponse.status, 201);
    assert.match(published.package.files[0].content, /max_velocity: 200/);
    assert.equal(published.package.tracksAppliedConfiguration, true);

    // Simulate a linked row created before migration 0020. The stored public
    // snapshot remains authoritative until the owner republishes it.
    await db.prepare("UPDATE public_packages SET approved_version_id = NULL WHERE slug = ?")
      .bind(published.slug)
      .run();
    const legacySnapshotResponse = await dispatch(`/api/packages/${published.slug}`);
    const legacySnapshot = await legacySnapshotResponse.json();
    assert.equal(legacySnapshotResponse.status, 200);
    assert.match(legacySnapshot.package.files.find((file) => file.path === "printer.cfg").content, /max_velocity: 200/);
    assert.equal(legacySnapshot.package.files.some((file) => file.path === "saved_variables.cfg"), false);
    assert.equal(Boolean(legacySnapshot.package.tracksAppliedConfiguration), false);
    const legacyStatusResponse = await dispatch(`/api/public-packages/${published.slug}/status`, {
      headers: { cookie: `__Host-klippee_session=${SESSION_TOKEN}` },
    });
    const legacyStatus = await legacyStatusResponse.json();
    assert.equal(legacyStatus.status.approvedVersionId, null);
    assert.equal(legacyStatus.status.hasUnpublishedAppliedVersion, true);

    const restoreLegacyApprovalResponse = await dispatch("/api/public-packages", {
      body: JSON.stringify({
        acknowledgeSafetyWarnings: true,
        expectedAppliedVersionId: initialCandidateBody.candidate.versionId,
        packageId,
        printerId,
        repositoryId: createdRepository.repository.id,
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    assert.equal(restoreLegacyApprovalResponse.status, 201);
    const initialPublication = await db.prepare(
      "SELECT approved_version_id, published_at, updated_at FROM public_packages WHERE slug = ?",
    )
      .bind(published.slug)
      .first();
    assert.equal(typeof initialPublication.approved_version_id, "string");

    const nextDesiredResponse = await dispatch(
      `/api/repos/${createdRepository.repository.id}/versions`,
      {
        body: JSON.stringify({
          files: [
            {
              content: "[printer]\nkinematics: corexy\nmax_velocity: 350\n",
              path: "printer.cfg",
              public: false,
              role: "printer",
            },
            {
              content: "[gcode_macro PARK]\ngcode: G1 X10 Y10\n",
              path: "macros.cfg",
              public: false,
              role: "macro",
            },
            {
              content: "[gcode_macro LIVE_SPEED]\nvariable_limit: ${KLIPPEE:live_speed}\ngcode:\n",
              path: "variables.cfg",
              public: false,
              role: "macro",
            },
            {
              content: "runtime_secret: still-private\n",
              path: "saved_variables.cfg",
              public: false,
              role: "include",
            },
          ],
          message: "Faster desired configuration",
          source: "web-editor",
        }),
        headers: {
          cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
          "content-type": "application/json",
          origin: WORKER_ORIGIN,
        },
        method: "POST",
      },
    );
    assert.equal(nextDesiredResponse.status, 201);

    const publicBeforeApplyResponse = await dispatch(`/api/packages/${published.slug}`);
    const publicBeforeApplyBody = await publicBeforeApplyResponse.json();
    assert.equal(publicBeforeApplyResponse.status, 200);
    assert.match(publicBeforeApplyBody.package.files[0].content, /max_velocity: 200/);
    assert.equal(publicBeforeApplyBody.package.files.some((file) => file.path === "macros.cfg"), false);

    const applyNextResponse = await dispatch(`/api/sync/repos/${createdRepository.repository.id}/applied`, {
      body: JSON.stringify({ versionNumber: 2 }),
      headers: {
        authorization: `Bearer ${token.token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    assert.equal(applyNextResponse.status, 200);

    const nextCandidateResponse = await dispatch(`/api/printers/${printerId}/publication-candidate`, {
      headers: { cookie: `__Host-klippee_session=${SESSION_TOKEN}` },
    });
    const nextCandidateBody = await nextCandidateResponse.json();
    assert.equal(nextCandidateResponse.status, 200);
    assert.equal(nextCandidateBody.candidate.repositoryId, createdRepository.repository.id);
    assert.equal(nextCandidateBody.candidate.versionNumber, 2);
    assert.notEqual(nextCandidateBody.candidate.versionId, initialCandidateBody.candidate.versionId);
    assert.deepEqual(
      nextCandidateBody.candidate.files.map((file) => file.path),
      ["printer.cfg", "macros.cfg", "variables.cfg"],
    );
    assert.equal(nextCandidateBody.candidate.files.every((file) => file.public), true);

    const publicResponse = await dispatch(`/api/packages/${published.slug}`);
    const publicBody = await publicResponse.json();
    assert.equal(publicResponse.status, 200);
    assert.match(
      publicBody.package.files.find((file) => file.path === "printer.cfg").content,
      /max_velocity: 200/,
    );
    assert.equal(publicBody.package.files.some((file) => file.path === "macros.cfg"), false);
    assert.deepEqual(publicBody.package.variables.map((variable) => variable.name), []);
    assert.equal(publicBody.package.files.every((file) => file.public), true);
    assert.equal(publicBody.package.tracksAppliedConfiguration, true);

    const catalogBeforeApprovalResponse = await dispatch("/api/packages");
    const catalogBeforeApproval = await catalogBeforeApprovalResponse.json();
    const catalogEntryBeforeApproval = catalogBeforeApproval.packages.find((pkg) => pkg.id === published.slug);
    assert.equal(catalogBeforeApprovalResponse.status, 200);
    assert.deepEqual(catalogEntryBeforeApproval.files.map((file) => file.path), ["printer.cfg"]);
    assert.deepEqual(catalogEntryBeforeApproval.variables, []);

    const publicationAfterPrinterApply = await db.prepare(
      "SELECT approved_version_id, published_at, updated_at FROM public_packages WHERE slug = ?",
    )
      .bind(published.slug)
      .first();
    assert.equal(publicationAfterPrinterApply.approved_version_id, initialPublication.approved_version_id);
    assert.equal(publicationAfterPrinterApply.published_at, initialPublication.published_at);
    assert.equal(publicationAfterPrinterApply.updated_at, initialPublication.updated_at);

    const anonymousStatusResponse = await dispatch(`/api/public-packages/${published.slug}/status`);
    assert.equal(anonymousStatusResponse.status, 401);
    const pendingStatusResponse = await dispatch(`/api/public-packages/${published.slug}/status`, {
      headers: { cookie: `__Host-klippee_session=${SESSION_TOKEN}` },
    });
    const pendingStatus = await pendingStatusResponse.json();
    assert.equal(pendingStatusResponse.status, 200);
    assert.equal(pendingStatus.status.approvedVersionId, initialPublication.approved_version_id);
    assert.equal(typeof pendingStatus.status.currentAppliedVersionId, "string");
    assert.notEqual(pendingStatus.status.currentAppliedVersionId, pendingStatus.status.approvedVersionId);
    assert.equal(pendingStatus.status.hasUnpublishedAppliedVersion, true);
    assert.equal(pendingStatus.status.linked, true);

    const otherOwnerStatusResponse = await dispatch(`/api/public-packages/${published.slug}/status`, {
      headers: { cookie: `__Host-klippee_session=${SECOND_SESSION_TOKEN}` },
    });
    assert.equal(otherOwnerStatusResponse.status, 404);

    const metadataUpdateResponse = await dispatch(`/api/public-packages/${published.slug}`, {
      body: JSON.stringify({
        description: "Owner-approved configuration snapshot.",
        hardware: ["CoreXY"],
        printer: "Approval boundary test printer",
        tags: ["approval-test"],
        title: "Approval boundary test",
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "PATCH",
    });
    const metadataUpdate = await metadataUpdateResponse.json();
    assert.equal(metadataUpdateResponse.status, 200);
    assert.match(
      metadataUpdate.package.files.find((file) => file.path === "printer.cfg").content,
      /max_velocity: 200/,
    );
    const statusAfterMetadataResponse = await dispatch(`/api/public-packages/${published.slug}/status`, {
      headers: { cookie: `__Host-klippee_session=${SESSION_TOKEN}` },
    });
    const statusAfterMetadata = await statusAfterMetadataResponse.json();
    assert.equal(statusAfterMetadata.status.approvedVersionId, pendingStatus.status.approvedVersionId);
    assert.equal(statusAfterMetadata.status.hasUnpublishedAppliedVersion, true);

    const staleApprovalResponse = await dispatch("/api/public-packages", {
      body: JSON.stringify({
        acknowledgeSafetyWarnings: true,
        expectedAppliedVersionId: initialCandidateBody.candidate.versionId,
        packageId,
        printerId,
        repositoryId: createdRepository.repository.id,
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const staleApproval = await staleApprovalResponse.json();
    assert.equal(staleApprovalResponse.status, 409);
    assert.equal(staleApproval.code, "applied_version_changed");
    assert.equal(staleApproval.currentAppliedVersionId, nextCandidateBody.candidate.versionId);
    const publicAfterStaleApprovalResponse = await dispatch(`/api/packages/${published.slug}`);
    const publicAfterStaleApproval = await publicAfterStaleApprovalResponse.json();
    assert.match(
      publicAfterStaleApproval.package.files.find((file) => file.path === "printer.cfg").content,
      /max_velocity: 200/,
    );

    const deleteApprovedResponse = await dispatch(
      `/api/repos/${createdRepository.repository.id}/versions/1`,
      {
        headers: {
          cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
          origin: WORKER_ORIGIN,
        },
        method: "DELETE",
      },
    );
    assert.equal(deleteApprovedResponse.status, 409);
    assert.match((await deleteApprovedResponse.json()).error, /owner-approved public configuration/i);

    const renderedBeforeApprovalResponse = await dispatch(`/api/packages/${published.slug}/render-preview`, {
      body: JSON.stringify({ variables: { live_speed: "275" } }),
      headers: { "content-type": "application/json", origin: WORKER_ORIGIN },
      method: "POST",
    });
    const renderedBeforeApproval = await renderedBeforeApprovalResponse.json();
    assert.equal(renderedBeforeApprovalResponse.status, 200);
    assert.equal(renderedBeforeApproval.files.some((file) => file.path === "macros.cfg"), false);

    const zipBeforeApprovalResponse = await dispatch(`/api/packages/${published.slug}/download.zip`, {
      body: JSON.stringify({ variables: {} }),
      headers: { "content-type": "application/json", origin: WORKER_ORIGIN },
      method: "POST",
    });
    const zipBeforeApproval = unzipSync(new Uint8Array(await zipBeforeApprovalResponse.arrayBuffer()));
    assert.equal(zipBeforeApprovalResponse.status, 200);
    assert.match(new TextDecoder().decode(zipBeforeApproval["printer.cfg"]), /max_velocity: 200/);
    assert.equal(Object.hasOwn(zipBeforeApproval, "macros.cfg"), false);

    const republishResponse = await dispatch("/api/public-packages", {
      body: JSON.stringify({
        acknowledgeSafetyWarnings: true,
        expectedAppliedVersionId: nextCandidateBody.candidate.versionId,
        packageId,
        printerId,
        repositoryId: createdRepository.repository.id,
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const republished = await republishResponse.json();
    assert.equal(republishResponse.status, 201);
    assert.match(republished.package.files.find((file) => file.path === "printer.cfg").content, /max_velocity: 350/);
    assert.equal(republished.package.files.some((file) => file.path === "saved_variables.cfg"), false);

    const approvedStatusResponse = await dispatch(`/api/public-packages/${published.slug}/status`, {
      headers: { cookie: `__Host-klippee_session=${SESSION_TOKEN}` },
    });
    const approvedStatus = await approvedStatusResponse.json();
    assert.equal(approvedStatusResponse.status, 200);
    assert.equal(approvedStatus.status.currentAppliedVersionId, approvedStatus.status.approvedVersionId);
    assert.equal(approvedStatus.status.hasUnpublishedAppliedVersion, false);

    const approvedPublicResponse = await dispatch(`/api/packages/${published.slug}`);
    const approvedPublic = await approvedPublicResponse.json();
    assert.equal(approvedPublicResponse.status, 200);
    assert.match(approvedPublic.package.files.find((file) => file.path === "printer.cfg").content, /max_velocity: 350/);
    assert.match(approvedPublic.package.files.find((file) => file.path === "macros.cfg").content, /gcode_macro PARK/);
    assert.deepEqual(approvedPublic.package.variables.map((variable) => variable.name), ["live_speed"]);

    const renderedResponse = await dispatch(`/api/packages/${published.slug}/render-preview`, {
      body: JSON.stringify({ variables: { live_speed: "275" } }),
      headers: { "content-type": "application/json", origin: WORKER_ORIGIN },
      method: "POST",
    });
    const renderedBody = await renderedResponse.json();
    assert.equal(renderedResponse.status, 200);
    assert.deepEqual(renderedBody.unresolvedVariables, []);
    assert.match(
      renderedBody.files.find((file) => file.path === "variables.cfg").content,
      /variable_limit: 275/,
    );

    const catalogResponse = await dispatch("/api/packages");
    const catalogBody = await catalogResponse.json();
    const catalogEntry = catalogBody.packages.find((pkg) => pkg.id === published.slug);
    assert.equal(catalogResponse.status, 200);
    assert.equal(catalogEntry.files.some((file) => file.path === "macros.cfg"), true);
    assert.equal(catalogEntry.files.every((file) => file.content === ""), true);
    assert.equal(catalogEntry.tracksAppliedConfiguration, true);
    assert.deepEqual(catalogEntry.variables.map((variable) => variable.name), ["live_speed"]);

    const publicationRow = await db.prepare(
      "SELECT approved_version_id, printer_id, repository_id FROM public_packages WHERE slug = ?",
    )
      .bind(published.slug)
      .first();
    assert.equal(publicationRow.repository_id, createdRepository.repository.id);
    assert.equal(publicationRow.printer_id, printerId);
    assert.equal(publicationRow.approved_version_id, approvedStatus.status.approvedVersionId);

    const destinationRepositoryResponse = await dispatch("/api/repos", {
      body: JSON.stringify({
        files: [{
          content: "[printer]\nkinematics: cartesian\n",
          path: "printer.cfg",
          public: false,
          role: "printer",
        }],
        title: "Rebound registry config",
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const destinationRepository = await destinationRepositoryResponse.json();
    assert.equal(destinationRepositoryResponse.status, 201);

    const applyUnpublishedOlderResponse = await dispatch(
      `/api/sync/repos/${createdRepository.repository.id}/applied`,
      {
        body: JSON.stringify({ versionNumber: 1 }),
        headers: {
          authorization: `Bearer ${token.token}`,
          "content-type": "application/json",
        },
        method: "POST",
      },
    );
    assert.equal(applyUnpublishedOlderResponse.status, 200);
    const statusBeforeRebindResponse = await dispatch(`/api/public-packages/${published.slug}/status`, {
      headers: { cookie: `__Host-klippee_session=${SESSION_TOKEN}` },
    });
    assert.equal((await statusBeforeRebindResponse.json()).status.hasUnpublishedAppliedVersion, true);

    const rebindResponse = await dispatch("/api/printers", {
      body: JSON.stringify({
        printer: {
          id: printerId,
          name: "Live registry printer",
          repositoryId: destinationRepository.repository.id,
        },
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    assert.equal(rebindResponse.status, 200);

    const frozenResponse = await dispatch(`/api/packages/${published.slug}`);
    const frozenBody = await frozenResponse.json();
    assert.equal(frozenResponse.status, 200);
    assert.equal(Boolean(frozenBody.package.tracksAppliedConfiguration), false);
    assert.match(
      frozenBody.package.files.find((file) => file.path === "printer.cfg").content,
      /max_velocity: 350/,
    );
    assert.deepEqual(frozenBody.package.variables.map((variable) => variable.name), ["live_speed"]);

    const frozenPublicationRow = await db.prepare(
      "SELECT approved_version_id, printer_id, repository_id FROM public_packages WHERE slug = ?",
    )
      .bind(published.slug)
      .first();
    assert.equal(frozenPublicationRow.repository_id, null);
    assert.equal(frozenPublicationRow.printer_id, null);
    assert.equal(frozenPublicationRow.approved_version_id, null);

    const catalogAfterRebindResponse = await dispatch("/api/packages");
    const catalogAfterRebindBody = await catalogAfterRebindResponse.json();
    const frozenCatalogEntry = catalogAfterRebindBody.packages.find((pkg) => pkg.id === published.slug);
    assert.equal(catalogAfterRebindResponse.status, 200);
    assert.equal(Boolean(frozenCatalogEntry.tracksAppliedConfiguration), false);
    assert.deepEqual(frozenCatalogEntry.variables.map((variable) => variable.name), ["live_speed"]);

    const deleteFormerlyApprovedResponse = await dispatch(
      `/api/repos/${createdRepository.repository.id}/versions/2`,
      {
        headers: {
          cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
          origin: WORKER_ORIGIN,
        },
        method: "DELETE",
      },
    );
    assert.equal(deleteFormerlyApprovedResponse.status, 200);

    const destinationTokenResponse = await dispatch(
      `/api/repos/${destinationRepository.repository.id}/sync-tokens`,
      {
        body: JSON.stringify({
          name: "Rebound registry printer token",
          printerId,
          scopes: ["repo:read", "repo:write"],
        }),
        headers: {
          cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
          "content-type": "application/json",
          origin: WORKER_ORIGIN,
        },
        method: "POST",
      },
    );
    const destinationToken = await destinationTokenResponse.json();
    assert.equal(destinationTokenResponse.status, 201);
    const applyDestinationResponse = await dispatch(
      `/api/sync/repos/${destinationRepository.repository.id}/applied`,
      {
        body: JSON.stringify({ versionNumber: 1 }),
        headers: {
          authorization: `Bearer ${destinationToken.token}`,
          "content-type": "application/json",
        },
        method: "POST",
      },
    );
    assert.equal(applyDestinationResponse.status, 200);
    const destinationCandidateResponse = await dispatch(`/api/printers/${printerId}/publication-candidate`, {
      headers: { cookie: `__Host-klippee_session=${SESSION_TOKEN}` },
    });
    const destinationCandidate = await destinationCandidateResponse.json();
    assert.equal(destinationCandidateResponse.status, 200);
    assert.equal(destinationCandidate.candidate.repositoryId, destinationRepository.repository.id);

    const relinkResponse = await dispatch("/api/public-packages", {
      body: JSON.stringify({
        acknowledgeSafetyWarnings: true,
        expectedAppliedVersionId: destinationCandidate.candidate.versionId,
        packageId,
        printerId,
        repositoryId: destinationRepository.repository.id,
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    assert.equal(relinkResponse.status, 201);

    const deletePrinterResponse = await dispatch(`/api/printers/${printerId}`, {
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        origin: WORKER_ORIGIN,
      },
      method: "DELETE",
    });
    assert.equal(deletePrinterResponse.status, 200);
    const snapshotAfterPrinterDeleteResponse = await dispatch(`/api/packages/${published.slug}`);
    const snapshotAfterPrinterDelete = await snapshotAfterPrinterDeleteResponse.json();
    assert.equal(snapshotAfterPrinterDeleteResponse.status, 200);
    assert.match(
      snapshotAfterPrinterDelete.package.files.find((file) => file.path === "printer.cfg").content,
      /kinematics: cartesian/,
    );
    assert.equal(Boolean(snapshotAfterPrinterDelete.package.tracksAppliedConfiguration), false);
    const rowAfterPrinterDelete = await db.prepare(
      "SELECT approved_version_id, printer_id, repository_id FROM public_packages WHERE slug = ?",
    )
      .bind(published.slug)
      .first();
    assert.equal(rowAfterPrinterDelete.repository_id, null);
    assert.equal(rowAfterPrinterDelete.printer_id, null);
    assert.equal(rowAfterPrinterDelete.approved_version_id, null);
  });

  it("keeps one publication when competing first-publish slugs use the stable row identity", async () => {
    const packageId = "concurrent-first-publication";
    await insertPrivatePackage(packageId, [{
      content: "# concurrent publication fixture\n",
      path: "printer.cfg",
      public: false,
      role: "printer",
    }]);

    const publish = () => dispatch("/api/public-packages", {
      body: JSON.stringify({ packageId }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const firstResponse = await publish();
    const firstResult = await firstResponse.json();
    assert.equal(firstResponse.status, 201);

    const firstRow = await db.prepare(
      `SELECT id, slug
       FROM public_packages
       WHERE user_id = ? AND source_package_id = ?`,
    )
      .bind("user_1", packageId)
      .first();
    const competingSlug = `${firstRow.slug}-competing`;
    const competingInsert = await db.prepare(
      `INSERT INTO public_packages
         (id, user_id, source_package_id, repository_id, printer_id, approved_version_id,
          slug, name, title, package_json, printer_facet, tags_facet, search_text,
          created_at, updated_at, published_at)
       SELECT id, user_id, source_package_id, repository_id, printer_id, approved_version_id,
              ?, name, title, package_json, printer_facet, tags_facet, search_text,
              created_at, updated_at, published_at
       FROM public_packages
       WHERE id = ?
       ON CONFLICT DO NOTHING`,
    )
      .bind(competingSlug, firstRow.id)
      .run();
    assert.equal(competingInsert.meta.changes, 0);

    const storedPackage = await db.prepare(
      "SELECT package_json FROM private_packages WHERE user_id = ? AND package_id = ?",
    )
      .bind("user_1", packageId)
      .first();
    const renamedPackage = JSON.parse(storedPackage.package_json);
    renamedPackage.name = `${packageId}-renamed`;
    renamedPackage.title = `${packageId}-renamed`;
    const renamedAt = new Date().toISOString();
    await db.prepare(
      `UPDATE private_packages
       SET name = ?, title = ?, package_json = ?, updated_at = ?
       WHERE user_id = ? AND package_id = ?`,
    )
      .bind(
        renamedPackage.name,
        renamedPackage.title,
        JSON.stringify(renamedPackage),
        renamedAt,
        "user_1",
        packageId,
      )
      .run();

    const republishResponse = await publish();
    const republished = await republishResponse.json();
    assert.equal(republishResponse.status, 201);
    assert.equal(republished.slug, firstResult.slug);

    const rows = await db.prepare(
      "SELECT slug FROM public_packages WHERE user_id = ? AND source_package_id = ?",
    )
      .bind("user_1", packageId)
      .all();
    assert.equal(rows.results.length, 1);
    assert.equal(rows.results[0].slug, firstResult.slug);
  });

  it("publishes stable owner-specific URLs that open without authentication", async () => {
    const packageId = "same-config-id";
    const files = [{
      content: "[printer]\nkinematics: cartesian\n",
      path: "printer.cfg",
      public: false,
      role: "printer",
    }];
    await insertPrivatePackage(packageId, files);
    await insertPrivatePackage(packageId, files, [], [], [], "user_2");

    const publish = async (token) => {
      const response = await dispatch("/api/public-packages", {
        body: JSON.stringify({ packageId }),
        headers: {
          cookie: `__Host-klippee_session=${token}`,
          "content-type": "application/json",
          origin: WORKER_ORIGIN,
        },
        method: "POST",
      });
      const body = await response.json();
      assert.equal(response.status, 201);
      return body;
    };

    const first = await publish(SESSION_TOKEN);
    const repeated = await publish(SESSION_TOKEN);
    const otherOwner = await publish(SECOND_SESSION_TOKEN);

    assert.equal(repeated.slug, first.slug);
    assert.equal(repeated.shareUrl, first.shareUrl);
    assert.equal(repeated.package.publicCreatedAt, first.package.publicCreatedAt);
    assert.notEqual(otherOwner.slug, first.slug);
    assert.notEqual(otherOwner.shareUrl, first.shareUrl);
    assert.equal(first.package.id, first.slug);
    assert.equal(first.package.sourcePackageId, packageId);

    const publicResponse = await dispatch(`/api/packages/${first.slug}`);
    const publicBody = await publicResponse.json();
    assert.equal(publicResponse.status, 200);
    assert.equal(publicBody.package.id, first.slug);
    assert.equal(publicBody.package.publicSlug, first.slug);
    assert.equal(publicBody.package.sourcePackageId, packageId);
    assert.equal(publicBody.package.files[0].content, files[0].content);

    const catalogResponse = await dispatch(`/api/packages?q=${encodeURIComponent(packageId)}`);
    const catalogBody = await catalogResponse.json();
    assert.equal(catalogResponse.status, 200);
    const published = catalogBody.packages.filter((pkg) => pkg.sourcePackageId === packageId);
    assert.equal(published.length, 2);
    assert.deepEqual(
      new Set(published.map((pkg) => pkg.id)),
      new Set([first.slug, otherOwner.slug]),
    );
    assert.equal(published.every((pkg) => pkg.publicSlug === pkg.id), true);
  });

  it("lets only the owner update public listing metadata without changing its files", async () => {
    const packageId = "editable-public-listing";
    const files = [{
      content: "[printer]\nkinematics: corexy\n",
      path: "printer.cfg",
      public: false,
      role: "printer",
    }];
    await insertPrivatePackage(packageId, files);
    const publishedResponse = await dispatch("/api/public-packages", {
      body: JSON.stringify({ packageId }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const published = await publishedResponse.json();
    assert.equal(publishedResponse.status, 201);

    const updateResponse = await dispatch(`/api/public-packages/${published.slug}`, {
      body: JSON.stringify({
        description: "Updated listing details.",
        hardware: ["CoreXY", "Beacon"],
        printer: "QIDI Plus 4",
        tags: ["qidi", "mainline"],
        title: "Updated public listing",
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "PATCH",
    });
    const updated = await updateResponse.json();
    assert.equal(updateResponse.status, 200);
    assert.equal(updated.package.title, "Updated public listing");
    assert.equal(updated.package.description, "Updated listing details.");
    assert.deepEqual(updated.package.hardware, ["CoreXY", "Beacon"]);
    assert.deepEqual(updated.package.tags, ["public", "qidi", "mainline"]);
    assert.equal(updated.package.files[0].content, files[0].content);
    assert.equal(updated.package.version, "2026.05.19");

    const publicResponse = await dispatch(`/api/packages/${published.slug}`);
    const publicBody = await publicResponse.json();
    assert.equal(publicBody.package.title, "Updated public listing");
    assert.equal(publicBody.package.files[0].content, files[0].content);

    const republishResponse = await dispatch("/api/public-packages", {
      body: JSON.stringify({ packageId }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const republished = await republishResponse.json();
    assert.equal(republishResponse.status, 201);
    assert.equal(republished.package.title, "Updated public listing");
    assert.deepEqual(republished.package.tags, ["public", "qidi", "mainline"]);

    const otherOwnerResponse = await dispatch(`/api/public-packages/${published.slug}`, {
      body: JSON.stringify({
        description: "Tampered",
        hardware: [],
        printer: "",
        tags: [],
        title: "Tampered",
      }),
      headers: {
        cookie: `__Host-klippee_session=${SECOND_SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "PATCH",
    });
    assert.equal(otherOwnerResponse.status, 404);
  });

  it("requires warning acknowledgement before publishing warning-only packages", async () => {
    await insertPrivatePackage("warning-package", [
      {
        content: "[extruder]\nheater_pin: PA1\n",
        path: "printer.cfg",
        public: false,
        role: "printer",
      },
      {
        content: "[save_variables]\nfilename: ~/printer_data/config/variables.cfg\n",
        path: "saved_variables.cfg",
        public: false,
        role: "include",
      },
    ]);

    const blocked = await dispatch("/api/public-packages", {
      body: JSON.stringify({ packageId: "warning-package" }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const blockedBody = await blocked.json();

    assert.equal(blocked.status, 409);
    assert.equal(blockedBody.error, "Safety warnings must be acknowledged before publishing this package");
    assert.equal(blockedBody.safetyFindings.some((finding) => finding.severity === "warn"), true);

    const published = await dispatch("/api/public-packages", {
      body: JSON.stringify({ acknowledgeSafetyWarnings: true, packageId: "warning-package" }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const publishedBody = await published.json();

    assert.equal(published.status, 201);
    assert.equal(publishedBody.package.files.some((file) => file.path === "saved_variables.cfg"), false);
    assert.equal(publishedBody.package.files.every((file) => file.public), true);
  });

  it("returns a conflict when private edits or republishes win during a metadata PATCH", async () => {
    const originalFiles = [{
      content: "[gcode_macro ORIGINAL]\ngcode: M117 old\n",
      path: "macros.cfg",
      public: false,
      role: "macro",
    }];
    const updatedFiles = [{
      content: "[gcode_macro UPDATED]\ngcode: M117 new\n",
      path: "macros.cfg",
      public: false,
      role: "macro",
    }];
    for (const scenario of ["private-edit", "republish", "both"]) {
      const packageId = `metadata-race-${scenario}`;
      await insertPrivatePackage(packageId, originalFiles);

      const initialPublish = await dispatch("/api/public-packages", {
        body: JSON.stringify({ packageId }),
        headers: {
          cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
          "content-type": "application/json",
          origin: WORKER_ORIGIN,
        },
        method: "POST",
      });
      assert.equal(initialPublish.status, 201);
      const initialBody = await initialPublish.json();

      const hook = armPublicListingPatchHook();
      const metadataPatch = dispatch(`/api/public-packages/${initialBody.slug}`, {
        body: JSON.stringify({
          description: "Metadata edit racing a concurrent package update.",
          hardware: ["CoreXY"],
          printer: "Race test printer",
          tags: ["race-test"],
          title: "Edited listing",
        }),
        headers: {
          cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
          "content-type": "application/json",
          origin: WORKER_ORIGIN,
        },
        method: "PATCH",
      });

      try {
        await hook.reached;
        if (scenario === "private-edit" || scenario === "both") {
          const privateEdit = await dispatch("/api/private-packages", {
            body: JSON.stringify({
              package: {
                description: "Concurrent private package edit.",
                files: updatedFiles,
                hardware: ["CoreXY"],
                id: packageId,
                name: packageId,
                printer: "Race test printer",
                tags: ["private"],
                title: "Private update",
                variables: [],
                version: "2026.10.08",
                warnings: [],
              },
            }),
            headers: {
              cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
              "content-type": "application/json",
              origin: WORKER_ORIGIN,
            },
            method: "POST",
          });
          assert.equal(privateEdit.status, 201);
        }

        if (scenario === "republish" || scenario === "both") {
          const republish = await dispatch("/api/public-packages", {
            body: JSON.stringify({ packageId }),
            headers: {
              cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
              "content-type": "application/json",
              origin: WORKER_ORIGIN,
            },
            method: "POST",
          });
          assert.equal(republish.status, 201);
        }
        hook.release();

        const patchResponse = await metadataPatch;
        const patchBody = await patchResponse.json();
        assert.equal(patchResponse.status, 409, `${scenario} must make the metadata edit conflict`);
        assert.equal(patchBody.code, "public_listing_conflict");

        const publicResponse = await dispatch(`/api/packages/${initialBody.slug}`);
        const publicBody = await publicResponse.json();
        assert.equal(publicResponse.status, 200);
        if (scenario === "both") {
          assert.match(publicBody.package.files[0].content, /gcode_macro UPDATED/);
          assert.doesNotMatch(publicBody.package.files[0].content, /gcode_macro ORIGINAL/);
        } else {
          assert.match(publicBody.package.files[0].content, /gcode_macro ORIGINAL/);
          assert.equal(publicBody.package.title, initialBody.package.title);
        }

        const privateResponse = await dispatch(`/api/private-packages/${packageId}`, {
          headers: { cookie: `__Host-klippee_session=${SESSION_TOKEN}` },
        });
        const privateBody = await privateResponse.json();
        assert.equal(privateResponse.status, 200);
        if (scenario === "private-edit" || scenario === "both") {
          assert.match(privateBody.package.files[0].content, /gcode_macro UPDATED/);
        } else {
          assert.match(privateBody.package.files[0].content, /gcode_macro ORIGINAL/);
        }
      } finally {
        hook.release();
      }
    }
  });

  it("requires public-review acknowledgement for literal device and network identities", async () => {
    await insertPrivatePackage("public-identity-warning-package", [
      {
        content: [
          "[mcu]",
          "serial: /dev/serial/by-id/usb-private-printer",
          "[mcu toolhead]",
          "canbus_uuid: 1234567890ab",
          "[authorization]",
          "trusted_clients: 192.168.1.0/24",
          "cors_domains: http://printer.local",
        ].join("\n"),
        path: "printer.cfg",
        public: false,
        role: "printer",
      },
    ]);

    const blocked = await dispatch("/api/public-packages", {
      body: JSON.stringify({ packageId: "public-identity-warning-package" }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const blockedBody = await blocked.json();
    assert.equal(blocked.status, 409);
    assert.equal(blockedBody.safetyFindings.some((finding) => finding.category === "device-identity"), true);
    assert.equal(blockedBody.safetyFindings.some((finding) => finding.category === "network-identity"), true);

    const published = await dispatch("/api/public-packages", {
      body: JSON.stringify({
        acknowledgeSafetyWarnings: true,
        packageId: "public-identity-warning-package",
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const publishedBody = await published.json();
    assert.equal(published.status, 201);
    assert.match(publishedBody.package.files.find((file) => file.path === "printer.cfg").content, /usb-private-printer/);
  });

  it("removes secret variable examples and generated descriptions from public package metadata", async () => {
    const packageId = "secret-metadata-package";
    const secretValue = "wifi-secret-that-must-never-be-public";
    await insertPrivatePackage(packageId, [{
      content: "[gcode_macro REPORT_SECRET]\ngcode: M117 ${KLIPPEE:wifi_password}\n",
      path: "macros/report-secret.cfg",
      public: false,
      role: "macro",
    }], [], [{
      description: `Printer-specific value detected from ${secretValue}.`,
      example: secretValue,
      label: "Wi-Fi password",
      name: "wifi_password",
      required: true,
      secret: true,
      type: "secret",
    }]);

    const publishedResponse = await dispatch("/api/public-packages", {
      body: JSON.stringify({ acknowledgeSafetyWarnings: true, packageId }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const published = await publishedResponse.json();
    const publishedVariable = published.package.variables.find((variable) => variable.name === "wifi_password");
    assert.equal(publishedResponse.status, 201);
    assert.equal(JSON.stringify(published).includes(secretValue), false);
    assert.equal(publishedVariable.secret, true);
    assert.equal("example" in publishedVariable, false);
    assert.equal(
      publishedVariable.description,
      "Secret value. Provide it privately when rendering or installing this package.",
    );

    const storedRow = await db.prepare(
      "SELECT package_json FROM public_packages WHERE slug = ?",
    ).bind(published.slug).first();
    assert.equal(storedRow.package_json.includes(secretValue), false);

    // Legacy rows may predate write-time sanitization, so public reads must
    // also remove previously stored secret examples and generated descriptions.
    const legacyPackage = JSON.parse(storedRow.package_json);
    legacyPackage.variables[0].description = `Printer-specific value detected from ${secretValue}.`;
    legacyPackage.variables[0].example = secretValue;
    await db.prepare(
      "UPDATE public_packages SET package_json = ? WHERE slug = ?",
    ).bind(JSON.stringify(legacyPackage), published.slug).run();

    const publicDetail = await dispatch(`/api/packages/${published.slug}`);
    const publicDetailBody = await publicDetail.json();
    const detailVariable = publicDetailBody.package.variables.find((variable) => variable.name === "wifi_password");
    assert.equal(publicDetail.status, 200);
    assert.equal(JSON.stringify(publicDetailBody).includes(secretValue), false);
    assert.equal("example" in detailVariable, false);

    const catalog = await dispatch(`/api/packages?q=${encodeURIComponent(packageId)}`);
    const catalogBody = await catalog.json();
    const catalogPackage = catalogBody.packages.find((pkg) => pkg.sourcePackageId === packageId);
    assert.equal(catalog.status, 200);
    assert.notEqual(catalogPackage, undefined);
    assert.equal(JSON.stringify(catalogPackage).includes(secretValue), false);
    assert.equal("example" in catalogPackage.variables[0], false);

    const updateListing = await dispatch(`/api/public-packages/${published.slug}`, {
      body: JSON.stringify({
        description: "Updated secret metadata fixture.",
        hardware: ["cartesian"],
        printer: "Bench printer",
        tags: ["fixture"],
        title: "Updated secret metadata package",
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "PATCH",
    });
    const updatedStoredRow = await db.prepare(
      "SELECT package_json FROM public_packages WHERE slug = ?",
    ).bind(published.slug).first();
    assert.equal(updateListing.status, 200);
    assert.equal(updatedStoredRow.package_json.includes(secretValue), false);
  });

  it("stores non-secret printer variable values and uses them for authenticated renders", async () => {
    await insertPrivatePackage("variable-package", [
      {
        content: "[mcu]\nserial: ${KLIPPEE:beacon_serial}\nsecret_value: ${KLIPPEE:wifi_password}\n",
        path: "printer.cfg",
        public: false,
        role: "printer",
      },
    ], [
      "Variable package fixture.",
    ], [
      {
        description: "Beacon USB serial path.",
        label: "Beacon serial",
        name: "beacon_serial",
        required: true,
        secret: false,
        type: "device-path",
      },
      {
        description: "Secret Wi-Fi password.",
        label: "Wi-Fi password",
        name: "wifi_password",
        required: true,
        secret: true,
        type: "text",
      },
    ]);

    const upsertPrinter = await dispatch("/api/printers", {
      body: JSON.stringify({
        printer: {
          id: "printer_variables",
          name: "Variable printer",
          packageIds: ["variable-package"],
          variableValues: {
            beacon_serial: "/dev/serial/by-id/klippee-profile",
            wifi_password: "do-not-store",
          },
        },
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const upsertBody = await upsertPrinter.json();

    assert.equal(upsertPrinter.status, 201);
    assert.equal(upsertBody.printer.variableValues.beacon_serial, "/dev/serial/by-id/klippee-profile");
    assert.equal("wifi_password" in upsertBody.printer.variableValues, false);

    const metadataOnlyUpdate = await dispatch("/api/printers", {
      body: JSON.stringify({
        printer: {
          id: "printer_variables",
          name: "Renamed variable printer",
          packageIds: ["variable-package"],
        },
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const metadataOnlyBody = await metadataOnlyUpdate.json();
    assert.equal(metadataOnlyUpdate.status, 200);
    assert.equal(metadataOnlyBody.printer.variableValues.beacon_serial, "/dev/serial/by-id/klippee-profile");

    const published = await dispatch("/api/public-packages", {
      body: JSON.stringify({ acknowledgeSafetyWarnings: true, packageId: "variable-package" }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const publishedBody = await published.json();

    assert.equal(published.status, 201);

    const preview = await dispatch(`/api/packages/${publishedBody.package.id}/render-preview`, {
      body: JSON.stringify({
        printerId: "printer_variables",
        variables: {
          wifi_password: "preview-must-not-render-secret",
        },
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const previewBody = await preview.json();
    const rendered = previewBody.files.find((file) => file.path === "printer.cfg")?.content ?? "";

    assert.equal(preview.status, 200);
    assert.equal(previewBody.ok, false);
    assert.match(rendered, /\/dev\/serial\/by-id\/klippee-profile/);
    assert.match(rendered, /\$\{KLIPPEE:wifi_password\}/);
    assert.equal(rendered.includes("preview-must-not-render-secret"), false);
    assert.deepEqual(previewBody.unresolvedVariables, ["wifi_password"]);

    // The package builder may bind a printer before its asynchronous package
    // save reaches D1. Saving (or later reclassifying) that package as secret
    // must scrub values from printers that are already bound to its id.
    const latePackageId = "late-secret-variable-package";
    const bindBeforePackageSave = await dispatch("/api/printers", {
      body: JSON.stringify({
        printer: {
          id: "printer_variables",
          name: "Renamed variable printer",
          packageIds: [latePackageId],
          variableValues: {
            beacon_serial: "/dev/serial/by-id/must-be-scrubbed",
          },
        },
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    assert.equal(bindBeforePackageSave.status, 200);

    const latePackage = (secret) => ({
      description: "Late-bound package secret reclassification fixture.",
      files: [{
        content: "[mcu]\nserial: ${KLIPPEE:beacon_serial}\n",
        path: "printer.cfg",
        public: false,
        role: "printer",
      }],
      hardware: ["cartesian"],
      id: latePackageId,
      name: latePackageId,
      printer: "Bench printer",
      tags: ["private", "fixture"],
      title: "Late secret package",
      variables: [{
        description: "Controller identity.",
        label: "Beacon serial",
        name: "beacon_serial",
        required: true,
        // Deliberately leave the legacy policy bit false. The explicit type is
        // authoritative and must be normalized to secret at the API boundary.
        secret: false,
        type: secret ? "secret" : "device-path",
      }],
      version: secret ? "2" : "1",
      warnings: [],
    });
    const saveLateNonSecretPackage = await dispatch("/api/private-packages", {
      body: JSON.stringify({ package: latePackage(false) }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    assert.equal(saveLateNonSecretPackage.status, 201);
    const valueBeforeReclassification = await db.prepare(
      "SELECT variable_values_json FROM printers WHERE id = ? AND user_id = ?",
    ).bind("printer_variables", "user_1").first();
    assert.equal(
      JSON.parse(valueBeforeReclassification.variable_values_json).beacon_serial,
      "/dev/serial/by-id/must-be-scrubbed",
    );

    const reclassifyLatePackage = await dispatch("/api/private-packages", {
      body: JSON.stringify({ package: latePackage(true) }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    assert.equal(reclassifyLatePackage.status, 201);
    const valueAfterReclassification = await db.prepare(
      "SELECT variable_values_json FROM printers WHERE id = ? AND user_id = ?",
    ).bind("printer_variables", "user_1").first();
    assert.equal("beacon_serial" in JSON.parse(valueAfterReclassification.variable_values_json), false);

    await insertPrivatePackage("beacon-secret-package", [{
      content: "[mcu]\nserial: ${KLIPPEE:beacon_serial}\n",
      path: "printer.cfg",
      public: false,
      role: "printer",
    }], [], [{
      description: "Host-local controller identity.",
      label: "Beacon serial",
      name: "beacon_serial",
      required: true,
      secret: true,
      type: "secret",
    }]);
    const reclassifySecret = await dispatch("/api/printers", {
      body: JSON.stringify({
        printer: {
          id: "printer_variables",
          name: "Renamed variable printer",
          packageIds: ["beacon-secret-package"],
        },
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const reclassifySecretBody = await reclassifySecret.json();
    assert.equal(reclassifySecret.status, 200);
    assert.equal("beacon_serial" in reclassifySecretBody.printer.variableValues, false);

    const explicitClear = await dispatch("/api/printers", {
      body: JSON.stringify({
        printer: {
          id: "printer_variables",
          name: "Renamed variable printer",
          packageIds: ["variable-package"],
          variableValues: {},
        },
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const explicitClearBody = await explicitClear.json();
    assert.equal(explicitClear.status, 200);
    assert.deepEqual(explicitClearBody.printer.variableValues, {});

    const invalidValues = await dispatch("/api/printers", {
      body: JSON.stringify({
        printer: {
          id: "printer_variables",
          name: "Renamed variable printer",
          variableValues: "not-an-object",
        },
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    assert.equal(invalidValues.status, 400);
    assert.deepEqual(await invalidValues.json(), { error: "Printer variableValues must be an object" });

    const arrayValues = await dispatch("/api/printers", {
      body: JSON.stringify({
        printer: {
          id: "printer_variables",
          name: "Renamed variable printer",
          variableValues: [],
        },
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    assert.equal(arrayValues.status, 400);
    assert.deepEqual(await arrayValues.json(), { error: "Printer variableValues must be an object" });

    const unboundSecretLikeValue = await dispatch("/api/printers", {
      body: JSON.stringify({
        printer: {
          id: "printer_variables",
          name: "Renamed variable printer",
          packageIds: [],
          variableValues: {
            api_token: "must-remain-host-local",
            beacon_serial: "/dev/serial/by-id/non-secret-still-persists",
          },
        },
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const unboundSecretLikeBody = await unboundSecretLikeValue.json();
    assert.equal(unboundSecretLikeValue.status, 200);
    assert.equal("api_token" in unboundSecretLikeBody.printer.variableValues, false);
    assert.equal(
      unboundSecretLikeBody.printer.variableValues.beacon_serial,
      "/dev/serial/by-id/non-secret-still-persists",
    );
  });

  it("patches printer variables atomically without erasing values or retaining secrets", async () => {
    const printerId = "printer_variable_patch";
    const sessionHeaders = {
      cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
      "content-type": "application/json",
      origin: WORKER_ORIGIN,
    };
    const patchVariable = (name, value, id = printerId) => dispatch(
      `/api/printers/${id}/variables/${name}`,
      {
        body: JSON.stringify({ value }),
        headers: sessionHeaders,
        method: "PATCH",
      },
    );

    const create = await dispatch("/api/printers", {
      body: JSON.stringify({
        printer: {
          id: printerId,
          name: "Atomic variable patch printer",
          packageIds: [],
          variableValues: { original_value: "preserved" },
        },
      }),
      headers: sessionHeaders,
      method: "POST",
    });
    assert.equal(create.status, 201);

    const firstPatch = await patchVariable("first_value", "first");
    const firstPatchBody = await firstPatch.json();
    assert.equal(firstPatch.status, 200);
    assert.equal(firstPatchBody.stored, true);
    assert.deepEqual(firstPatchBody.printer.variableValues, {
      first_value: "first",
      original_value: "preserved",
    });

    // App-state and metadata saves do not own the separately persisted values.
    // Omitting variableValues here must therefore preserve the first patch.
    const metadataUpdate = await dispatch("/api/printers", {
      body: JSON.stringify({
        printer: {
          id: printerId,
          name: "Renamed atomic variable patch printer",
          packageIds: [],
        },
      }),
      headers: sessionHeaders,
      method: "POST",
    });
    const metadataUpdateBody = await metadataUpdate.json();
    assert.equal(metadataUpdate.status, 200);
    assert.deepEqual(metadataUpdateBody.printer.variableValues, {
      first_value: "first",
      original_value: "preserved",
    });

    const secondPatch = await patchVariable("second_value", 2);
    const secondPatchBody = await secondPatch.json();
    assert.equal(secondPatch.status, 200);
    assert.equal(secondPatchBody.stored, true);
    assert.deepEqual(secondPatchBody.printer.variableValues, {
      first_value: "first",
      original_value: "preserved",
      second_value: 2,
    });

    for (const invalidBody of [null, []]) {
      const invalid = await dispatch(`/api/printers/${printerId}/variables/invalid_value`, {
        body: JSON.stringify(invalidBody),
        headers: sessionHeaders,
        method: "PATCH",
      });
      assert.equal(invalid.status, 400);
    }

    const nonexistent = await patchVariable("first_value", "not-stored", "missing-variable-printer");
    assert.equal(nonexistent.status, 404);
    assert.deepEqual(await nonexistent.json(), { error: "Printer not found" });

    const oversizedValue = await patchVariable("first_value", "x".repeat(4_097));
    const oversizedValueBody = await oversizedValue.json();
    assert.equal(oversizedValue.status, 413);
    assert.equal(oversizedValueBody.code, "printer_variable_value_too_large");
    const afterOversizedValue = await db.prepare(
      "SELECT variable_values_json FROM printers WHERE id = ? AND user_id = ?",
    ).bind(printerId, "user_1").first();
    assert.equal(JSON.parse(afterOversizedValue.variable_values_json).first_value, "first");

    const aggregatePrinterId = "printer_variable_aggregate_limit";
    const createAggregatePrinter = await dispatch("/api/printers", {
      body: JSON.stringify({
        printer: {
          id: aggregatePrinterId,
          name: "Aggregate variable limit printer",
          variableValues: { stable_value: "before" },
        },
      }),
      headers: sessionHeaders,
      method: "POST",
    });
    assert.equal(createAggregatePrinter.status, 201);
    const legacyAggregateValues = {
      legacy_padding: "x".repeat(65_000),
      stable_value: "before",
    };
    assert.equal(Buffer.byteLength(JSON.stringify(legacyAggregateValues)) < 64 * 1_024, true);
    await db.prepare(
      "UPDATE printers SET variable_values_json = ? WHERE id = ? AND user_id = ?",
    ).bind(JSON.stringify(legacyAggregateValues), aggregatePrinterId, "user_1").run();

    const oversizedAggregate = await patchVariable(
      "stable_value",
      "y".repeat(4_096),
      aggregatePrinterId,
    );
    const oversizedAggregateBody = await oversizedAggregate.json();
    assert.equal(oversizedAggregate.status, 413);
    assert.equal(oversizedAggregateBody.code, "printer_variable_values_too_large");
    const afterOversizedAggregate = await db.prepare(
      "SELECT variable_values_json FROM printers WHERE id = ? AND user_id = ?",
    ).bind(aggregatePrinterId, "user_1").first();
    assert.equal(JSON.parse(afterOversizedAggregate.variable_values_json).stable_value, "before");

    // Legacy rows may contain values written before the storage boundary. A
    // secret-like PATCH must report that it was not stored and scrub the key.
    const beforeHeuristicScrub = await db.prepare(
      "SELECT variable_values_json FROM printers WHERE id = ? AND user_id = ?",
    ).bind(printerId, "user_1").first();
    const heuristicValues = JSON.parse(beforeHeuristicScrub.variable_values_json);
    heuristicValues.api_token = "legacy-secret";
    await db.prepare(
      "UPDATE printers SET variable_values_json = ? WHERE id = ? AND user_id = ?",
    ).bind(JSON.stringify(heuristicValues), printerId, "user_1").run();
    const heuristicSecret = await patchVariable("api_token", "must-stay-host-local");
    const heuristicSecretBody = await heuristicSecret.json();
    assert.equal(heuristicSecret.status, 200);
    assert.equal(heuristicSecretBody.stored, false);
    assert.equal("api_token" in heuristicSecretBody.printer.variableValues, false);
    const afterHeuristicScrub = await db.prepare(
      "SELECT variable_values_json FROM printers WHERE id = ? AND user_id = ?",
    ).bind(printerId, "user_1").first();
    assert.equal("api_token" in JSON.parse(afterHeuristicScrub.variable_values_json), false);

    const secretPackageId = "patch-declared-secret-package";
    await insertPrivatePackage(secretPackageId, [{
      content: "[mcu]\nserial: ${KLIPPEE:machine_identity}\n",
      path: "printer.cfg",
      public: false,
      role: "printer",
    }], [], [{
      description: "Host-local controller identity.",
      label: "Machine identity",
      name: "machine_identity",
      required: true,
      secret: true,
      type: "secret",
    }]);
    const bindSecretPackage = await dispatch("/api/printers", {
      body: JSON.stringify({
        printer: {
          id: printerId,
          name: "Renamed atomic variable patch printer",
          packageIds: [secretPackageId],
        },
      }),
      headers: sessionHeaders,
      method: "POST",
    });
    assert.equal(bindSecretPackage.status, 200);

    const beforeDeclaredSecretScrub = await db.prepare(
      "SELECT variable_values_json FROM printers WHERE id = ? AND user_id = ?",
    ).bind(printerId, "user_1").first();
    const declaredSecretValues = JSON.parse(beforeDeclaredSecretScrub.variable_values_json);
    declaredSecretValues.machine_identity = "legacy-package-secret";
    await db.prepare(
      "UPDATE printers SET variable_values_json = ? WHERE id = ? AND user_id = ?",
    ).bind(JSON.stringify(declaredSecretValues), printerId, "user_1").run();

    // Reads are fail-closed as well as writes, including directly seeded legacy
    // values which have not yet passed through a scrub operation.
    const listBeforeDeclaredSecretScrub = await dispatch("/api/printers", {
      headers: { cookie: `__Host-klippee_session=${SESSION_TOKEN}` },
    });
    const listedBeforeDeclaredSecretScrub = await listBeforeDeclaredSecretScrub.json();
    const listedSecretPrinter = listedBeforeDeclaredSecretScrub.printers.find(
      (printer) => printer.id === printerId,
    );
    assert.equal(listBeforeDeclaredSecretScrub.status, 200);
    assert.equal("machine_identity" in listedSecretPrinter.variableValues, false);

    const declaredSecret = await patchVariable("machine_identity", "must-stay-host-local");
    const declaredSecretBody = await declaredSecret.json();
    assert.equal(declaredSecret.status, 200);
    assert.equal(declaredSecretBody.stored, false);
    assert.equal("machine_identity" in declaredSecretBody.printer.variableValues, false);
    const afterDeclaredSecretScrub = await db.prepare(
      "SELECT variable_values_json FROM printers WHERE id = ? AND user_id = ?",
    ).bind(printerId, "user_1").first();
    assert.equal("machine_identity" in JSON.parse(afterDeclaredSecretScrub.variable_values_json), false);

    // The full-map endpoint still supports an intentional explicit clear.
    const explicitClear = await dispatch("/api/printers", {
      body: JSON.stringify({
        printer: {
          id: printerId,
          name: "Renamed atomic variable patch printer",
          packageIds: [secretPackageId],
          variableValues: {},
        },
      }),
      headers: sessionHeaders,
      method: "POST",
    });
    const explicitClearBody = await explicitClear.json();
    assert.equal(explicitClear.status, 200);
    assert.deepEqual(explicitClearBody.printer.variableValues, {});
  });

  it("scrubs public-package values when an innocuous variable is republished as secret", async () => {
    const packageId = "public-secret-reclassification-package";
    const printerId = "printer_public_secret_reclassification";
    const sessionHeaders = {
      cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
      "content-type": "application/json",
      origin: WORKER_ORIGIN,
    };
    const packageDefinition = (secret) => ({
      description: "Public secret reclassification fixture.",
      files: [{
        content: "[mcu]\nserial: ${KLIPPEE:machine_identity}\n",
        path: "printer.cfg",
        public: false,
        role: "printer",
      }],
      hardware: ["cartesian"],
      id: packageId,
      name: packageId,
      printer: "Bench printer",
      tags: ["private", "fixture"],
      title: "Public secret reclassification package",
      variables: [{
        description: "Controller identity.",
        label: "Machine identity",
        name: "machine_identity",
        required: true,
        // The explicit type is authoritative even if an older client leaves
        // the legacy secret bit false.
        secret: false,
        type: secret ? "secret" : "text",
      }],
      version: secret ? "2" : "1",
      warnings: [],
    });

    const saveNonSecret = await dispatch("/api/private-packages", {
      body: JSON.stringify({ package: packageDefinition(false) }),
      headers: sessionHeaders,
      method: "POST",
    });
    assert.equal(saveNonSecret.status, 201);
    const publishNonSecret = await dispatch("/api/public-packages", {
      body: JSON.stringify({ acknowledgeSafetyWarnings: true, packageId }),
      headers: sessionHeaders,
      method: "POST",
    });
    const published = await publishNonSecret.json();
    assert.equal(publishNonSecret.status, 201);

    const bindPublicPackage = await dispatch("/api/printers", {
      body: JSON.stringify({
        printer: {
          id: printerId,
          name: "Public secret reclassification printer",
          packageIds: [published.slug],
          variableValues: { machine_identity: "legacy-public-value" },
        },
      }),
      headers: sessionHeaders,
      method: "POST",
    });
    const boundPublicPackage = await bindPublicPackage.json();
    assert.equal(bindPublicPackage.status, 201);
    assert.equal(boundPublicPackage.printer.variableValues.machine_identity, "legacy-public-value");

    const reclassifyPrivatePackage = await dispatch("/api/private-packages", {
      body: JSON.stringify({ package: packageDefinition(true) }),
      headers: sessionHeaders,
      method: "POST",
    });
    assert.equal(reclassifyPrivatePackage.status, 201);
    const republishSecret = await dispatch("/api/public-packages", {
      body: JSON.stringify({ acknowledgeSafetyWarnings: true, packageId }),
      headers: sessionHeaders,
      method: "POST",
    });
    assert.equal(republishSecret.status, 201);

    const afterRepublish = await db.prepare(
      "SELECT variable_values_json FROM printers WHERE id = ? AND user_id = ?",
    ).bind(printerId, "user_1").first();
    assert.equal("machine_identity" in JSON.parse(afterRepublish.variable_values_json), false);

    // Public-package bindings need the same legacy read filtering as private
    // package IDs even if stale data is introduced outside the API boundary.
    await db.prepare(
      "UPDATE printers SET variable_values_json = ? WHERE id = ? AND user_id = ?",
    ).bind(JSON.stringify({ machine_identity: "directly-seeded-public-secret" }), printerId, "user_1").run();
    const listPrinters = await dispatch("/api/printers", {
      headers: { cookie: `__Host-klippee_session=${SESSION_TOKEN}` },
    });
    const listedPrinters = await listPrinters.json();
    const listedPrinter = listedPrinters.printers.find((printer) => printer.id === printerId);
    assert.equal(listPrinters.status, 200);
    assert.equal("machine_identity" in listedPrinter.variableValues, false);
  });

  it("blocks public publishing when the stored package has blocking safety findings", async () => {
    await insertPrivatePackage("blocking-package", [
      {
        content: "[moonraker]\napi_key: supersecretvalue\n",
        path: "moonraker.cfg",
        public: false,
        role: "moonraker",
      },
    ]);

    const response = await dispatch("/api/public-packages", {
      body: JSON.stringify({ acknowledgeSafetyWarnings: true, packageId: "blocking-package" }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const body = await response.json();

    assert.equal(response.status, 422);
    assert.equal(body.error, "Safety scan blocked publishing this package");
    assert.equal(body.safetyFindings.some((finding) => finding.severity === "block"), true);
  });

  it("renders a public package preview without a session", async () => {
    const published = await publishStoredPackage();
    const response = await dispatch(`/api/packages/${published.slug}/render-preview`, {
      body: JSON.stringify({ variables: {} }),
      headers: {
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.package.id, published.slug);
    assert.equal(body.package.sourcePackageId, "package_1");
    assert.deepEqual(body.unresolvedVariables, []);
    assert.equal(body.files.some((file) => file.path === "printer.cfg"), true);
  });

  it("downloads a rendered public package zip without a session", async () => {
    const published = await publishStoredPackage();
    const response = await dispatch(`/api/packages/${published.slug}/download.zip`, {
      body: JSON.stringify({ variables: {} }),
      headers: {
        accept: "application/zip",
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const bytes = new Uint8Array(await response.arrayBuffer());

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/zip/);
    assert.equal(bytes[0], 0x50);
    assert.equal(bytes[1], 0x4b);
    assert.equal(response.headers.get("x-klippee-artifact-storage"), "skipped");
    assert.equal(response.headers.get("x-klippee-artifact-storage-reason"), "ephemeral-download");
    assert.equal(response.headers.has("x-klippee-artifact-key"), false);
  });

  it("rejects public template expansion before preview or ZIP output exceeds the package bound", async () => {
    const packageId = "bounded-render-package";
    await insertPrivatePackage(
      packageId,
      [{
        content: `[printer]\nnotes: ${"${KLIPPEE:amplifier}".repeat(300)}\nprototype: ${"${KLIPPEE:constructor}"}\n`,
        path: "printer.cfg",
        public: false,
        role: "printer",
      }],
      [],
      [{
        description: "Repeated public render value.",
        label: "Amplifier",
        name: "amplifier",
        required: true,
        secret: false,
        type: "string",
      }, {
        description: "Prototype-name regression value.",
        label: "Constructor",
        name: "constructor",
        required: true,
        secret: false,
        type: "string",
      }],
    );
    const publishResponse = await dispatch("/api/public-packages", {
      body: JSON.stringify({ acknowledgeSafetyWarnings: true, packageId }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const published = await publishResponse.json();
    assert.equal(publishResponse.status, 201);

    const variables = { amplifier: "x".repeat(64 * 1_024) };
    for (const path of ["render-preview", "download.zip"]) {
      const response = await dispatch(`/api/packages/${published.slug}/${path}`, {
        body: JSON.stringify({ variables }),
        headers: { "content-type": "application/json", origin: WORKER_ORIGIN },
        method: "POST",
      });

      assert.equal(response.status, 413);
      assert.deepEqual(await response.json(), {
        code: "rendered_package_too_large",
        error: "Rendered package exceeds the 1024000-byte limit. Shorten variable values and try again.",
        limitBytes: 1_024_000,
      });
    }

    const invalidValueResponse = await dispatch(`/api/packages/${published.slug}/render-preview`, {
      body: JSON.stringify({ variables: { amplifier: "safe", constructor: ["nested"] } }),
      headers: { "content-type": "application/json", origin: WORKER_ORIGIN },
      method: "POST",
    });
    assert.equal(invalidValueResponse.status, 400);
    assert.deepEqual(await invalidValueResponse.json(), {
      code: "invalid_package_variables",
      error: "Package variable constructor must be a string, number, boolean, or null",
    });

    const unresolvedResponse = await dispatch(`/api/packages/${published.slug}/render-preview`, {
      body: JSON.stringify({ variables: { amplifier: "safe" } }),
      headers: { "content-type": "application/json", origin: WORKER_ORIGIN },
      method: "POST",
    });
    const unresolvedBody = await unresolvedResponse.json();
    const renderedContent = unresolvedBody.files.find((file) => file.path === "printer.cfg")?.content ?? "";
    assert.equal(unresolvedResponse.status, 200);
    assert.equal(unresolvedBody.ok, false);
    assert.equal(unresolvedBody.errors.constructor, "Required");
    assert.deepEqual(unresolvedBody.unresolvedVariables, ["constructor"]);
    assert.match(renderedContent, /\$\{KLIPPEE:constructor\}/);
    assert.equal(renderedContent.includes("function Object"), false);
  });

  it("derives public variable metadata from live placeholders for unlinked packages", async () => {
    const packageId = "live-variable-schema-package";
    await insertPrivatePackage(packageId, [{
      content: "[gcode_macro REPORT_SECRET]\ngcode: M117 ${KLIPPEE:undeclared_secret}\n",
      path: "macros/report-secret.cfg",
      public: false,
      role: "macro",
    }]);

    const response = await dispatch("/api/public-packages", {
      body: JSON.stringify({ acknowledgeSafetyWarnings: true, packageId }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const body = await response.json();
    const variable = body.package.variables.find((candidate) => candidate.name === "undeclared_secret");

    assert.equal(response.status, 201);
    assert.notEqual(variable, undefined);
    assert.equal(variable.required, true);
    assert.equal(variable.secret, true);
    assert.equal(variable.type, "secret");
  });

  it("does not store rendered zip artifacts when secret variables are supplied", async () => {
    const published = await publishStoredPackage();
    const response = await dispatch(`/api/packages/${published.slug}/download.zip`, {
      body: JSON.stringify({ variables: { wifi_password: "correct horse battery staple" } }),
      headers: {
        accept: "application/zip",
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const bytes = new Uint8Array(await response.arrayBuffer());

    assert.equal(response.status, 200);
    assert.equal(bytes[0], 0x50);
    assert.equal(bytes[1], 0x4b);
    assert.equal(response.headers.get("x-klippee-artifact-storage"), "skipped");
    assert.equal(response.headers.get("x-klippee-artifact-storage-reason"), "ephemeral-download");
    assert.equal(response.headers.has("x-klippee-artifact-key"), false);
  });

  it("keeps repeated distinct rendered zip downloads out of R2", async () => {
    const packageId = "ephemeral-render-package";
    await insertPrivatePackage(
      packageId,
      [{
        content: "[mcu]\nserial: ${KLIPPEE:mcu_serial}\n",
        path: "printer.cfg",
        public: false,
        role: "printer",
      }],
      [],
      [{
        description: "Public serial used to produce distinct valid renders.",
        label: "MCU serial",
        name: "mcu_serial",
        required: true,
        secret: false,
        type: "string",
      }],
    );
    const publish = await dispatch("/api/public-packages", {
      body: JSON.stringify({ acknowledgeSafetyWarnings: true, package: { id: packageId } }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const published = await publish.json();
    assert.equal(publish.status, 201);

    const bucket = await mf.getR2Bucket("BLOBS");
    const countArtifacts = async () => {
      const listing = await bucket.list({ prefix: "artifacts/rendered-zips/" });
      return listing.objects.length;
    };
    const download = (mcuSerial) =>
      dispatch(`/api/packages/${published.slug}/download.zip`, {
        body: JSON.stringify({ variables: { mcu_serial: mcuSerial } }),
        headers: {
          accept: "application/zip",
          "content-type": "application/json",
          origin: WORKER_ORIGIN,
        },
        method: "POST",
      });

    const countBefore = await countArtifacts();
    const first = await download("/dev/serial/by-id/fixture-one");
    await first.arrayBuffer();
    const second = await download("/dev/serial/by-id/fixture-two");
    await second.arrayBuffer();
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.headers.get("x-klippee-artifact-storage-reason"), "ephemeral-download");
    assert.equal(second.headers.get("x-klippee-artifact-storage-reason"), "ephemeral-download");
    assert.equal(first.headers.has("x-klippee-artifact-key"), false);
    assert.equal(second.headers.has("x-klippee-artifact-key"), false);
    assert.equal(await countArtifacts(), countBefore);
  });

  it("rate-limits unauthenticated package render/download requests (#280)", async () => {
    const tempMf = new Miniflare({
      compatibilityDate: "2026-05-12",
      bindings: {
        APP_ORIGIN: WORKER_ORIGIN,
        SESSION_SECRET,
      },
      d1Databases: { DB: "klippee-ratelimit-test" },
      modules: true,
      ratelimits: {
        PACKAGE_RATE_LIMITER: { namespace_id: "test-pkg", simple: { limit: 3, period: 60 } },
      },
      r2Buckets: { BLOBS: "klippee-ratelimit-blobs" },
      scriptPath: "dist/klippee/index.js",
    });

    try {
      // klipper-cartesian-starter is a bundled package, so preview needs no D1 seeding.
      const preview = () =>
        tempMf.dispatchFetch(new URL("/api/packages/klipper-cartesian-starter/render-preview", WORKER_ORIGIN), {
          body: JSON.stringify({ variables: {} }),
          headers: {
            "cf-connecting-ip": "203.0.113.7",
            "content-type": "application/json",
            origin: WORKER_ORIGIN,
          },
          method: "POST",
        });

      const statuses = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await preview();
        statuses.push(response.status);
        if (response.status === 429) {
          assert.equal(response.headers.get("retry-after"), "60");
          assert.match((await response.json()).error, /limit reached/i);
        } else {
          await response.arrayBuffer();
        }
      }

      // limit=3 per period: first three succeed, the fourth is throttled.
      assert.deepEqual(statuses.slice(0, 3), [200, 200, 200]);
      assert.equal(statuses[3], 429);
    } finally {
      await tempMf.dispose();
    }
  });
});
