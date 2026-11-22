# Klippee for OrcaSlicer

Version 1.6.0 browses and restores library profiles directly inside Orca and imports an account-wide profile library: enabled printer profiles
and all custom process and filament profiles. A physical printer such as example1
can link to several nozzle variants, and one profile can link to several devices.
No physical printer needs to be selected or even exist in Klippee to import.
The plugin does not connect to or control a physical printer.

## Browse and restore inside OrcaSlicer

1. Install or update to plugin **1.6.0**.
2. In Klippee's Orca Workspace, choose **Browse library in OrcaSlicer** and copy
   the code. Use it within ten minutes to pair this Orca installation once.
3. In Orca's Klippee page, paste it under **Browse your Klippee library** and
   choose **Open library**. No JSON download or file picker is needed.
4. Search by profile name or nozzle size, or filter printer profiles, custom
   filaments or custom processes. Choose a profile and **Review selected profile**.
5. Review the name and ancestry, then **Restore preset copies**. Select the new
   copy in Prepare when needed. **Check last restore** verifies its settings and
   parents without changing the active setup.

**Reload library** fetches the current Klippee list. If another import replaced
it, an old selection is rejected until it is reloaded. The reviewed snapshot is
then fixed for that restore. Current selections, edit buffers, slots and models
are preserved throughout. The same native copy and inheritance verification is
used for file-based restores; exported JSON remains an optional offline backup.

Connections start read-only: they permit listing the library and retrieving an
individual profile with its ancestors. Uploads need the separate permission below.
No connection can publish content, delete saved setups or control a printer. **Disconnect library** removes local
access and revokes the installation. The web workspace also lists connected
installations with a **Disconnect** button for each.

Browser-authenticated `POST /api/orca/pair-connection` creates a ten-minute
pairing grant with normal origin protection and rate limiting. Native
`POST /api/orca/restore/pair` exchanges it for a plugin-generated device secret.
The older `/api/orca/restore-connection` API remains available for 1.4 clients.
Bearer-only `/api/orca/restore/library` and `/api/orca/restore/profile` check
revocation on every request. Profile requests pin the library import ID. Only
exact native POST routes bypass browser origin checks; cookies cannot authorize
them. Network audit checks run in the main callback before a request starts.

## Import profiles

1. Use OrcaSlicer 2.5.0-alpha (verified Windows build `3880f2c5`).
2. In Klippee's **Orca Workspace**, open **Plugin installation and help** and
   download the plugin. Install or update it through Orca's Plugins manager.
3. Choose **Import from OrcaSlicer** in Klippee and copy the one-use code.
4. Open Klippee in Orca's plugin pages, paste the code and choose **Review import**.
   Review the profile list and destination, then **Import profiles to Klippee**.
5. The workspace updates automatically. Browse **Printer profiles**, **Custom
   filaments** and **Custom processes**. Expand a printer profile to optionally
   link physical printers. Links organise profiles; they do not control devices.

The scope uses Orca's native `is_user()` and `is_visible` flags, never name
heuristics or compatibility with the currently selected printer. Unselected
nozzle variants and custom filaments are included. System ancestors and the
current selected setup are retained as dependencies. Captured unsaved edits are
separate from saved profile settings and keep their ordered filament slots.

In Orca Workspace, usable Klippee restore copies have readable names and a
**Restored** label. Generated supporting presets are hidden from the list and
its counts, while their settings and inheritance remain in backups and profile
exports. Expand a restored profile to see its exact Orca preset name. Existing
library imports use this display without another import.

Profiles also display nozzle size, printer model, filament material and process
layer-height tags from the saved settings. Process and filament nozzle tags use
their explicit printer compatibility lists. The **Nozzle size** filter applies
across all three profile tabs; unrestricted profiles remain available for any
size. Missing printer references and compatibility expressions are marked for
review rather than treated as unrestricted. Search also matches these tags.
Existing imports gain tags from their stored preset settings when reloaded.

Each import replaces the account's latest library snapshot atomically; it does
not merge conflicting names from different installations. Optional printer links
and immutable saved setups are retained. Renaming a profile creates a different
profile identity; old links are not guessed onto the new name. The workspace
shows the latest import time, not a live connection. **Reload library** reloads
Klippee's stored data; it does not read Orca. Import again to capture changes.

**Export library backup** downloads every imported profile, ancestor and the
captured current setup. This is a library archive, not a saved-setup restore file.
The restore flow accepts individual profile exports (1.3.0+) and saved setup exports. The separate preset
editor continues to edit individual file copies, independently of the backup.

## Save the current setup

Expand **Saved setups**, choose **Save current setup from OrcaSlicer**, then use
that code in the plugin. Review the selected printer profile, process, ordered
filament slots and unsaved edits, name the setup and choose **Save to Klippee**.
Existing saved setups remain available across physical printer changes. Deleting
a physical printer removes its optional links, not the library or saved setups.

Codes expire after ten minutes. They authorize one import or one setup save,
not account access or downloading. Repeating a request is idempotent; replaying
an older successful import cannot overwrite a newer import. Requests are limited
to 8 MB and 768 ancestry nodes for libraries, 512 KB for individual setups.
Library nodes are stored separately to stay within D1 row limits. Imports use a
single transactional batch, so failures cannot leave a partially replaced library.

Grant Orca's requested preset-file and network permissions when using the
plugin. Capture runs on Orca's UI thread; HTTP runs in a background thread.
Changes to profiles or the current setup after review require a fresh review.
Connection/account fields are excluded; custom G-code is included. No models or
printer actions are sent.

The standard `urllib.Request` audit event runs inside Orca's message callback
before starting the HTTP worker, DNS or socket activity. Orca's permission
decision gates the exact request despite its thread-local audit context.
Requests use direct connections; environment proxies and redirects are disabled.

## Restore a saved setup

1. In Klippee, choose **Export saved setup** on the saved copy you want.
2. In Orca's Klippee page, under **Restore from Klippee**, open that JSON file.
   Review the printer, process and ordered filament slots. Restore only trusted
   files: custom G-code is preserved and can execute when you later print.
3. Choose **Restore preset copies**. Grant Orca's preset-file write permission
   if requested. The plugin creates a unique local namespace, loads parents
   before children, and verifies the native settings and every inheritance link.
   Your active selections, unsaved edits and model remain unchanged.
4. In Prepare, select the exact restored printer name shown by the plugin, then
   its process and each listed filament slot in order. Add or remove slots to
   match the list. Save or keep any current
   edits if Orca asks. Orca 2.5.0-alpha's plugin API has no selection setters;
   importing does not automatically switch the active setup.
5. Choose **Check last restore**. It checks all selected names, effective
   settings and ancestry. It also works after restarting Orca.

Captured unsaved edits become child presets above copies of their original saved
presets. Repeated filament slots receive distinct children so their edits remain
independent. Compatibility lists retain original targets and add the restored
ancestors. Every restore creates new copies; originals are never replaced.
Printer connection/account fields are excluded on restore as well as save.

The plugin retains the latest sanitized restore receipt in its own storage so it
can check the selection after restart. It contains preset settings, not a
connection code. It does not download setups using the save-only connection code.
If native loading or verification fails, the plugin reports that the new copies
may remain and must not be used. They stay on disk because the alpha API cannot
unload already loaded parents safely. Original presets remain untouched.

## Responsiveness, page reload and unload

JSON validation and restore planning run in a worker using copied values only.
Preset file writes, bundle reloads and native verification advance in short
steps through page messages, retaining Orca's audit context. Each step obtains
fresh host views and releases them before yielding. Native `reload_local()`
itself still runs on Orca's UI thread, as required by the API.

The page requests authoritative Python state on load, recovering its review,
edited title, restore selections and busy/progress state without echoing the
connection code. A reloaded page resumes polling unfinished operations.

Cancel or unload stops new work, cancels socket I/O without joining a blocked
reader, closes staged restore work and clears connection codes and reviews.
Cancelled workers retain no native handles and their eventual results are
discarded, including after re-enabling the plugin. On Windows an in-flight
socket read can finish at its timeout despite socket shutdown; DNS follows the
OS resolver's deadline. Neither is waited on by the UI. A save already accepted
by Klippee can still complete. Reload the library or saved setups before retrying it.

Interrupted restore copies stay on disk because Orca has no unload API for
presets. A marker in plugin storage warns about those unverified copies after
reload/restart. Restore the saved file again before using new copies.

This follows Orca's [Pages](https://www.orcaslicer.com/wiki/developer_reference/plugin_development/api_reference/pages),
[Host](https://www.orcaslicer.com/wiki/developer_reference/plugin_development/api_reference/host)
and [audit](https://www.orcaslicer.com/wiki/developer_reference/plugin_development/plugin_audit_hook.html)
contracts without changing Orca itself.

Version 1.6.0 remembers a read-only library connection across Orca restarts.
It does not sync automatically or connect to the physical printer. Klippee lists
paired installations and their last library request; that is not a live status.

## Authorization and privacy

Connection codes authorize one new setup for one account-owned printer. They
cannot list/download setups, edit existing assets, publish content, or operate
the printer. Cancelling a code revokes it. Codes contain an HTTPS service origin
and a random bearer value in the URL fragment; the bearer is sent only in an
Authorization header, never an API URL. The server stores only its keyed hash.
HTTP is permitted only for loopback development. Redirects are rejected.

The plugin keeps upload codes and captures in memory, not Orca settings or project
files. A successful save clears them. Explicit Cancel
clears the reviewed capture and code from plugin memory; use **Cancel code** in
Klippee to revoke server authorization as well.

Known printer connection and account credential fields are excluded in both
the plugin and server. The review shows excluded field names. This is not a
general secret scanner: custom G-code and unknown setting values are included,
so inspect custom macros for personal information before saving. Setups remain
private and have no publishing route.

Retries with the same code return the first successful setup rather than
creating duplicates. Removing a saved setup also revokes its original code.
Expired/cancelled codes require a new code. Each account can retain 20 saved
setups (maximum 512 KB per capture) and five unexpired connection codes. Remove
an old setup or cancel/wait for an old code when reaching these limits.

## Restore an individual library profile (1.3.0)

Expand a printer, custom filament or custom process in the Orca profile library
and choose **Export profile for OrcaSlicer**. In plugin 1.3.0 or later, open that
JSON under **Restore from Klippee**, review the profile, then restore copies.
The export contains only that saved profile and its full ancestry, not the
current setup's unsaved edits or other library profiles. The plugin creates a
separate namespaced copy of every ancestor and a clearly named leaf, verifies
all exposed settings and inheritance edges after native reload, and preserves
the active printer, process, filament slots, edits and models. Select the new
copy in Prepare when needed. **Check last restore** verifies that copy and all
ancestors without requiring it to be selected; complete setup checks still
require the full ordered selections. Receipt checks work after a restart.
Physical printer links remain organisation metadata in Klippee and are not
restored as printer connections. Nothing is sent to a physical printer.

The profile download is an authenticated, account-owned GET at
`/api/orca/library/profile-export?profileId=...`; only library roots can be
exported. It uses `klippee-orca-profile/v1` inside the `snapshot` wrapper and
includes a single saved-state selection. Missing parents, cycles, unrelated
nodes, captured edits and malformed identities are rejected before disk writes.


## Remembered library connections (1.5.0)

Choose **Browse library in OrcaSlicer** in Klippee and paste the code once into
**Browse your Klippee library** in the plugin. The pairing code expires after ten
minutes. The plugin exchanges it for a separate read-only device credential;
expiry of the pairing code does not disconnect the installation. Opening the
plugin after a restart loads the library automatically. Offline errors keep the
remembered connection and can be retried with **Reload library**.

The backend stores only a keyed hash in `orca_devices` (migration 0026) and limits
each account to ten installations. New connections authorize library listing,
individual profile downloads and disconnecting themselves. Version 1.6 adds an
owner-controlled upload permission; read-only connections cannot upload. Device
credentials cannot read saved setups, manage other devices or operate a printer. Pairing is
idempotent for the same client-generated secret and rejects a second secret.
Cancelling the pairing code also revokes a device paired through it.

The device secret is kept in `library-connection.json` in SDK-owned plugin
storage, never in page messages, presets, projects or restore receipts. On POSIX
the file is created with mode 0600; Windows inherits the user's application-data
permissions. It is a bearer credential, not an encrypted vault: anyone who can
read that account's plugin storage can access its library, and upload if enabled,
until revocation. Do not
share or publish plugin storage backups. Disabling/unloading the plugin clears
memory while retaining this file for the next launch.

**Disconnect library** removes the local credential and revokes it at Klippee.
If offline or a permission is denied, local removal still succeeds; revoke the
installation under **Connected Orca installations** in the web workspace when
online. Web revocation takes effect on the next request. A rejected credential
is forgotten locally. Pair again to reconnect. Existing profiles and models are
never removed by disconnecting.


## Import profiles and save setups using the connection (1.6.0)

Update the plugin to 1.6.0. Keep the existing connection: no new pairing code is
needed. In Klippee, expand **Connected Orca installations** and enable **Allow
profile imports and setup saves** for the intended installation. Existing and
new connections remain read-only until their owner enables this permission.

In Orca, choose **Review profile import** or **Review current setup**. The first
captures enabled printer profiles, all custom filament/process profiles and the
current setup; the second captures just the current combination, with ordered
filament slots, inheritance and unsaved edits. Review the destination and contents,
then confirm the upload. A setup needs a name. Changed settings require another
review. Nothing syncs automatically and no printer is contacted. Reload the web
workspace to see an upload made through the saved connection.

`POST /api/orca/device/upload-connection` authenticates the saved device credential
and requires its upload permission. It authorizes one ten-minute operation with
its own client-generated ID and secret, retained only in plugin memory. The
existing import/save endpoints keep their validation, size/storage limits and
retry receipts. A retry creates at most one snapshot/import; a fresh review gets
a new ID. The long-lived device credential is never accepted directly as an
upload grant. No account/printer ID can be supplied to change ownership.

Migration 0027 adds `uploads_enabled` (default false) and ties temporary operation
grants to their device. Turning uploads off deletes all of that installation's
pending grants in the same transaction. Disconnecting also removes them, while
saved profiles and setups remain. The server checks permission for each use;
revocation between review and confirmation prevents the upload. Library writes
remain atomic and optional physical-printer links survive imports.

## Share profiles in Shared Configs

In **Orca Workspace**, expand a printer, filament or process profile and choose
**Publish to Shared Configs**. Give the listing a readable name and description,
review the exact saved profile and its ancestors, and confirm public access. The listing
keeps the derived nozzle, material, layer-height and printer-model tags. Supporting
restore presets are included as ancestors, rather than offered as separate listings.

Connection credentials are removed again before publication. Detected credentials
in custom G-code block publishing; other findings require acknowledgement. Review
all G-code and identifying details yourself as well. Captured unsaved edits, other
library profiles, printer links and saved setups are excluded. If the imported
library changes during review, open a fresh review before publishing.

Published profiles appear under
[**Shared Configs → Orca profiles**](https://klippee.xyz/shared-configs?type=orca),
with search, profile type and nozzle filters. Their `/assets/...` links work
without signing in. Download
the JSON and open it under **Restore from Klippee** in plugin 1.3.0 or later. The
native snapshot retains ancestry and unknown settings; the plugin restores copies.
Review compatibility names and custom G-code for the destination printer.

Enable **Automatically update after Orca re-imports** to update an existing listing
from the latest imported saved profile and future imports. Otherwise, imports stay
private until you choose **Review and republish**. Automatic updates retain the
public name, description and URL, update derived tags, and keep full ancestry.
Repeated identical imports do not create new public versions. Unsaved edits and
new, unpublished profiles remain private. A renamed or missing profile is not
matched by guesswork; its last public version remains available with a review
message. Findings pause changed profiles for manual review. Disabling updates or
removing a listing prevents later imports from publishing it automatically.

Choose **Related printer config** to link a profile to one of your published
printer configurations. The profile page links to the configuration that supplies
its macros, and the configuration page lists its related Orca profiles and nozzle
tags. This is an owner-declared relationship, not an automatic compatibility test.
Changing the link or automatic-update setting saves immediately for a published
profile without creating another profile version. Configurations removed from
Shared Configs are unlinked automatically.

Republish updates the existing link even if its public name changes.
**Remove from Shared Configs** withdraws the listing without deleting the private
profile. Publication is limited
to 64 public profiles per account and 480 KB per profile including its ancestors;
private export remains available for larger profiles.

The browser-only review, publish and removal endpoints use
`/api/orca/library/publication`; `PATCH` manages publication settings. Native
connections cannot change those settings. An authorized import updates only
listings that their owner has already opted into automatic updates.
Public snapshots use the existing `public_companion_assets` store. The anonymous
`GET /api/public-companion-assets` catalog returns summaries, with `q`, `kind`,
`nozzle` and `offset` filters and 24 results per page. Migration 0029 stores native
profile identities, automatic-update status and the public printer-config link.
`GET /api/public-packages/:slug/orca-profiles` returns the reciprocal public links.
