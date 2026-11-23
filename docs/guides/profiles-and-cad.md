# Profiles and parametric CAD
> [!CAUTION]
> Printer configuration can move hardware or energise heaters. Review pins,
> thermistors, motion limits, included files, and rendered variables for the
> exact printer target before applying configuration. Klippee creates backups
> and asks before overwrites, but it does not make an unreviewed configuration
> safe.

## Create filament and slicer profiles

Open **Orca Workspace → Open preset editor** to manage individual saved presets.
Import a preset or bundle, or choose **New printer**, **New process** or **New
filament**. Enter a name, edit the applicable settings, and choose **Save preset**.
Signed-in saves are stored in your account's cloud preset library.

To remove one, select it, choose **Delete**, read the confirmation and choose
**Delete preset**. This removes the hosted preset and this browser's cached copy.
Presets attached to private configuration packages are protected; remove those
attachments or delete an unused package first. A changed preset requires a reload
before deletion. Pending imports, saves and publications must finish first.

Published copies and their public configuration links remain available. Deleting
a preset does not unpublish it, change printer files, remove saved configuration
history, or remove independent imported backups and saved setups. Local state is
kept if cloud deletion fails. Legacy or unrecognised formats appear under
**Other saved assets**, where they can also be inspected and deleted.

Publishing makes the profile public. Review notes, G-code, machine identifiers,
and any other content before sharing.


## Generate parametric CAD components

Open **Gridfinity Editor**, **OpenGrid Editor**, or **OpenGrid Underware
Editor** for transient parametric CAD work.

1. Select the type of component from the library on the left.
2. Adjust the component parameters on the right.
3. Choose **Generate preview**.
4. Inspect the interactive 3D preview.
5. Export the generated STL when satisfied.

The pre-loaded SCAD and generated geometry are processed transiently and are
not stored in Klippee. Component choices and parameters are saved only in the
current browser.
