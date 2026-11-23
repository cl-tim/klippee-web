# Web Editing and History

Klippee treats the web editor as the primary authoring surface for a printer's
mutable pending draft. It keeps that draft separate from the immutable version
that the physical printer last confirmed as installed/applied.

This does not need full Git semantics. The MVP needs:

- who changed what
- when it changed
- which files changed
- a diff between versions
- rollback to a previous version
- fork from a specific version

Branches, merge commits, rebases, and a full Git protocol are out of scope for
the first version.

## Editing Flow

1. User opens a private printer repository.
2. Klippee shows the current draft and the last applied version separately.
3. User edits one or more files.
4. Klippee validates syntax, package variables, and safety findings.
5. User reviews a diff.
6. Klippee autosaves the complete file set into one mutable pending draft. This
   does not create an immutable version.
7. The printer shows that a draft is available. The operator reviews it and
   explicitly runs `klippee apply` on the physical printer.
8. The client revalidates the content revision, writes rendered files, and
   reports the exact canonical target snapshot used for that render. Only then
   does Klippee create or reuse an immutable version and advance the printer's
   applied pointer and timestamp. Host-local variable values are not uploaded.
9. If the workspace is public, its stable Shared Configs listing URL continues to serve the
   last owner-approved snapshot. Klippee shows the owner that the newly applied
   version is unpublished so they can review and explicitly republish it.

## Editor Features

MVP editor features:

- file tree
- text editor with Klipper-friendly syntax highlighting
- search across files
- autosaved draft status
- rendered preview for templated files
- diff and safety review before printer apply
- printer target and last-applied status

## History Model

Klippee can implement lightweight history without running Git.

Objects:

- `blob`: content-addressed file content
- `tree`: list of paths, modes, roles, and blob hashes
- `version`: tree hash, previous version id, author, timestamp, message

Example:

```text
version 12
tree 11aa22
previous 11
author Tim
message Tune Beacon offsets
```

This model supports:

- full linear history
- diffs
- rollback
- file restore
- sync by version id
- fork from any version
- deduplication across versions

## Version Sources

Each version should record its source:

- `printer-apply`
- `capture`
- `zip-import`
- `public-package-install`
- `recovery`
- `api`

This helps users understand whether a change came from the site, a printer, an
import, or an automation.

## Draft and Applied State

The repository and its physical printer expose deliberately different state:

- `pending_files_json` and `pending_updated_at`: one mutable draft written by
  web autosave or accepted desktop capture. The size-bounded draft is kept
  inline and overwritten in D1, rather than creating an immutable blob for
  every autosave;
- `latest_version_id`: newest immutable repository version, which is not by
  itself evidence of what a printer uses;
- `applied_version_id` and `applied_at`: the version and time last confirmed by
  the physical printer.

There is no separate known-good pointer. Applied state is owned by the
physical-printer sync path; browser printer-profile updates and desktop tokens
cannot set it. A printer capture creates a recovery point and advances applied
state. A desktop capture only replaces the draft after its saved baseline
revision passes conflict checking.

The printer sync client never treats autosave as permission to apply. Default
behavior shows configuration drift and asks before writing. The optional
systemd timer is check-only and cannot advance applied state.

## Public Workspace Listings

Publishing a printer workspace links the public listing to its private
repository and explicit printer ID. At publish time, Klippee sanitizes and
stores a public snapshot of the exact applied repository version the owner
approved. The listing metadata remains independently editable, but changing
metadata does not approve or replace its configuration files:

- publishing requires that the selected printer has confirmed at least one
  applied configuration;
- publishing never promotes or exposes the current editor draft;
- public detail, preview, download, and catalog requests serve the stored
  owner-approved snapshot rather than resolving the printer's current
  `applied_version_id`;
- the stable public URL does not change as the configuration evolves;
- a later physical apply or capture changes the printer's authoritative applied
  record but remains unpublished until the owner reviews and republishes it;
- the owner-only listing status identifies when the printer has a newer applied
  version, and the publisher shows the exact applied files being reviewed;
- republishing names that immutable version ID and fails if applied state changed
  before approval, preventing a printer credential from racing different files
  into the public snapshot;
- the exposed variable schema is rebuilt from placeholders in the approved
  public files at publication time, so added or removed variables do not leave
  stale rendering requirements;
- rebinding or deleting the printer retains the last approved public snapshot
  and unlinks it without substituting the printer's current unapproved state;
- private-only paths and local variable values remain excluded.

Standalone packages that are not backed by a printer workspace remain explicit
publish-time snapshots. Legacy linked listings also retain their stored public
snapshot, but have no approved-version provenance until the owner republishes.

## Recovery

Recovery should preserve history.

Rollback behavior:

1. The workspace shows saved recovery points and their changelogs.
2. The operator runs `klippee recover` on the physical printer.
3. The operator runs `klippee recover cloud:<id>`.
4. If a pending draft exists and the newest saved point is selected, Klippee
   cancels only that exact draft without creating duplicate history. Selecting
   an older point creates a recovery target whose tree matches it.
5. The client applies it with its normal revision check and local backup.
6. Only a successful physical apply advances the printer's applied pointer. A
   linked public listing remains on its last approved snapshot until the owner
   explicitly republishes the recovered configuration.

This avoids deleting history while still giving the user a clear way back to a
working config.

## Restore One File

The hosted API can restore a single file from an older repository version without
rewriting history:

```text
POST /api/repos/:repoId/restore-file
```

Request body:

```json
{
  "path": "printer.cfg",
  "sourceVersionNumber": 3,
  "message": "Restore printer.cfg from version 3"
}
```

The Worker loads the latest immutable version, replaces only the requested path
with the file from `sourceVersionNumber`, re-runs the safety scan, and creates a
new immutable recovery target. Other files from the latest version are
preserved. This does not change the printer's applied pointer or public listing;
the physical
printer must explicitly apply the recovery target. Private repository ownership
is checked before any version data is returned or restored.

## Fork From Version

Public packages and private repositories should support fork-from-version.

Forking creates a new repository or package with:

- source package/repo id
- source version id
- copied tree
- new owner
- new history beginning at the fork point

The fork does not need to preserve every previous version in the MVP. It only
needs to record where it came from.

## Conflict Handling

A conflict can happen when a browser or desktop workspace has local edits and
another editor changed the pending target since that workspace last
synchronized.

Initial behavior:

- save a content revision in each client's local sync metadata;
- save the browser workspace baseline with its printer record and require it on
  every pending-draft autosave;
- reject stale restored browser state with a visible conflict instead of
  overwriting a newer desktop draft;
- report local-only, target-only, and diverged changes in `klippee check`;
- require desktop capture to supply its baseline revision;
- reject stale desktop capture without changing either cloud draft or local
  baseline;
- refetch the target after apply review and abort before writing if it changed;
- allow apply to use the revalidated target after backup.

## Audit Trail

Version metadata should include:

- author user id
- version timestamp
- change note
- source
- previous version id
- affected paths
- safety scan result
- optional printer id

The printer record adds the applied timestamp. The mutable draft has its own
updated timestamp and content revision but is not represented as an applied
audit event.

For private repositories, the audit trail is visible only to authorized users.
