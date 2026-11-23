# Configuration workspace
> [!CAUTION]
> Printer configuration can move hardware or energise heaters. Review pins,
> thermistors, motion limits, included files, and rendered variables for the
> exact printer target before applying configuration. Klippee creates backups
> and asks before overwrites, but it does not make an unreviewed configuration
> safe.

## Edit configuration files

### Open, create, rename, or remove a file

- Select a file in **Configuration Files** to open it.
- Enter a path such as `macros/start_print.cfg` and choose **Create** to add a
  file in a subfolder.
- Use the pencil beside a file to rename it.
- Use the bin beside a file to remove it from the draft.
- Use the upload action to import one or more `.cfg` files. Create a subfolder
  path explicitly when its relative path matters.

Klippee keeps edits as a browser draft while you move between files. The
timestamp beneath the editor confirms when the draft was last autosaved.
For a linked cloud workspace, autosave also stages the complete file set as one
mutable pending draft. Autosave is not applied history: it does not change the
printer's last confirmed configuration or a linked public listing.

### Review before applying

Open **Workspace tools → Review** to check:

- changed files and the proposed diff;
- missing `[include ...]` targets;
- unresolved variables;
- lint and safety findings.

Warnings are prompts to inspect the configuration. Blocking findings must be
resolved before a package can be installed or downloaded.


## Turn a value into a variable

Variables let one reusable configuration render different machine-specific
values for each printer.

1. In the editor, select the literal value you want to vary. You may select the
   entire `name: value` or `name = value` line; Klippee isolates its value and
   preserves any trailing comment.
2. Choose **Make variable** in the editor selection action.
3. Review the suggested variable name and placeholder.
4. Choose **Convert value**.
5. Open **Workspace tools → Variables** and confirm the value for the active
   printer.
6. Review the configuration when the rendered result is correct; it remains an
   autosaved draft until the physical printer applies or captures it.

Only the selected occurrence is converted. Klippee replaces it with
`${KLIPPEE:variable_name}` and uses the old non-secret literal as that
printer's initial value.

Secret values are deliberately not seeded into the browser profile. Set one on
the printer host instead:

```bash
hlab klippee variables set variable_name value
hlab klippee variables doctor
```

Use `hlab klippee variables list` to see the values available to the client. Check
and apply render placeholders with the selected printer's values before
comparing files.


## Draft, apply, and recover configurations

To prepare a printer update:

1. Finish edits across all affected files.
2. Review the warnings and diff.
3. Wait for the editor's autosave status. The **Printers** page will show that a
   draft is available.
4. On the physical printer, run `hlab klippee check --diff`, review the exact target,
   then run `hlab klippee apply`.

The web draft is mutable and is not an applied record. Physical apply fetches
the target again after review, renders and writes one exact target snapshot,
then reports that canonical snapshot and revision. Host-local variable values
stay on the client. A physical `hlab klippee capture` can instead choose the
printer's current local files as authoritative. Either successful physical
operation establishes the last confirmed installed/applied version and time.
There is no separate known-good pin.

Open **Workspace tools → Recovery** to inspect saved recovery points.

Recovery labels distinguish the newest immutable repository target from
**Applied**, the configuration last reported by the physical printer client.
Newest does not imply applied, and a pending editor draft is not an immutable
recovery point.

Select a recovery point to view its changes relative to the previous point. To
restore it, run the displayed `hlab klippee recover cloud:<id>` command on the
physical printer. Recovery preserves the audit trail. Deleting a recovery point
requires confirmation, at least one point must remain, and the last confirmed
applied point cannot be deleted.


## Delete an old saved configuration

Open **Printers → Saved configurations** to see your saved cloud configurations,
including ones no longer linked to a printer. Choose **Delete**, review the
configuration name, and confirm **Delete saved configuration**. This permanently
removes its saved draft, all recovery versions, associated diagnostic uploads,
and cloud sync access. It does not contact printers or change their files.

A configuration still linked to a printer or public listing cannot be deleted.
Remove those links in Klippee first. History used by another configuration is
also protected. If the configuration changes while the list is open, refresh
and review it again before deleting. Deleting a cloud copy does not remove
independent browser drafts, downloaded backups, or separately saved packages.


## Link a physical printer

Linking connects hlab to one printer. The token can access only that printer's
private configuration repository. Install hlab with the `klippee` command group
on the printer host first.

1. Open **Printers** and select the printer.
2. In **Link printer**, choose **Create import token**.
3. Copy the generated command immediately; the complete token is shown once.
4. Run the command over SSH on the printer's Linux host.
5. Use the printer's real config directory when prompted. The common path is
   `~/printer_data/config`.
6. Let the initial capture complete, then reload **Printers**.

If `hlab` is unavailable, confirm the release binary is installed and its
folder is on the printer user's `PATH`.


## Restore one file from history

Open **Recovery**, select a recovery point, choose **File to restore**, then
**Review file restore**. The diff compares that saved file with your current
draft, including unsaved local edits. Review the replacement and choose
**Restore file to draft** to stage it. A file removed from the current draft can
also be added back this way. Other draft files keep their current contents.

This creates a pending draft; it does not create a saved recovery point or change
the printer's confirmed applied state. Apply the draft on the printer when ready.
**Cancel file restore**, Escape or closing Recovery before confirmation leaves
the working draft unchanged. Single-file restore requires a cloud-linked printer.

Klippee refetches the saved source and current cloud revision before confirming.
If you edit locally after the preview, review the file again. If another browser
or printer capture changes the cloud draft, close Recovery and use **Review
conflict** first. If a write cannot be confirmed, your local edits remain intact
and sync pauses for review. Closing or navigating away during a confirmed write
also preserves local edits and requires conflict review before resuming.


## Resolve a workspace conflict

If another browser or desktop capture changes the cloud configuration, web
workspace sync pauses and your local edits stay open. Choose **Review conflict**
to compare each file's baseline, local contents and current cloud contents.
Independent file changes have a suggested result. When both sides changed the
same file, choose **Use local file** or **Use cloud file**. Choosing an absent
side removes that file from the reviewed result. If an older browser cache has
no recoverable baseline, differing files always require an explicit choice.

Choose **Stage reviewed files** to confirm the complete result for the connected
printer to apply. Klippee checks the latest cloud revision again and retains the
server's revision guard. If the cloud changes again, review the refreshed files
and confirm again. If you edit locally during review or staging, those newer
edits remain intact and require a new review. The result must retain at least
one file and pass the existing safety checks.

**Keep editing locally** closes the review without staging anything; sync stays
paused. Use **Refresh review** to include your newest local edits. File-level
choices keep an entire file; to combine changes within one file, keep editing
that file locally and review it again.
