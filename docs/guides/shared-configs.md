# Shared Configs
> [!CAUTION]
> Printer configuration can move hardware or energise heaters. Review pins,
> thermistors, motion limits, included files, and rendered variables for the
> exact printer target before applying configuration. Klippee creates backups
> and asks before overwrites, but it does not make an unreviewed configuration
> safe.

## Use Shared Configs

Open [**Shared Configs**](https://klippee.xyz/shared-configs) to browse public
configuration packages. Search by name, printer, or tag, then open a result to
inspect its files, hardware notes,
variables, warnings, version, and share link.

Use the [**Orca profiles** tab](https://klippee.xyz/shared-configs?type=orca) for
shared printer, filament, and process profiles. Older `/registry` links redirect
automatically to `/shared-configs`, preserving filters such as `?type=orca`.

Before using a package:

1. Confirm the exact printer and hardware revision.
2. Read all package warnings.
3. Choose **Configure package**.
4. Supply required printer-specific variables.
5. Review the rendered config and changed-file summary.
6. Download the rendered archive or bind it to the intended private printer.

Shared configs are community content and are not tested or endorsed by
Klippee. Never install solely because the printer model name appears to match.

### Delete an obsolete private package

Open **Shared Configs → Private packages** while signed in. Choose **Delete**,
review the package name and public-copy warning, then confirm **Delete private
package**. The hosted private copy and its entry in this browser's package
library are removed. Printer files, saved configuration history, companion
assets and independent copies in other browsers are unchanged.

Packages still bound to a printer in Klippee are protected. Unbind them first.
Published Shared Configs snapshots remain public and keep their existing URLs;
deleting a private source does not unpublish them. You can still edit your
public listing's details after deleting its private source. If another edit or
binding changes the package while you are confirming, refresh and review again.

### Publish and share a workspace config

1. Open **Klipper Workspace** for a printer with a cloud configuration.
   The printer must have confirmed at least one applied configuration.
2. Select **Publish to Shared Configs**.
3. Enter a clear listing title, printer model, hardware, and useful tags.
4. Review any safety warnings, then select **Publish to Shared Configs**.
5. Copy the public link shown in the workspace.

Publishing links the listing to this explicit printer and its repository. It
does not publish or promote the current editor draft. The link opens without
sign-in and serves a stored snapshot of the applied configuration you approved
when publishing. Draft autosaves and desktop captures remain private. A later
successful physical apply or capture updates the printer's applied record, but
not the public files; Klippee shows that newer configuration to you as
unpublished until you review and republish it. Private-only and sensitive files
are excluded.

To share a newer applied configuration, reopen **Publish to Shared Configs**,
review the exact applied-version files and safety findings shown there, and choose
**Approve and republish**. If the printer reports a different applied version
before the request completes, Klippee asks you to review again instead of
publishing different files. The public URL stays the same. Editing the listing
title, printer details, hardware, or tags does not approve or change its files.

Older linked listings continue to serve their existing stored snapshot. Open
the publishing flow and republish once to associate that snapshot with an exact
owner-approved applied version.
