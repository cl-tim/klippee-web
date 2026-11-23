# Getting started

Klippee stores and reviews printer configuration drafts before operators explicitly apply a reviewed configuration. Begin with the browser workflow, then choose a printer connection when you are ready.

## Start in Klippee

1. Open [klippee.xyz](https://klippee.xyz) and sign in.
2. Open **Klipper Workspace** in the navigation.
3. Create a printer or select an existing one.
4. Import the printer's current files before replacing a working configuration.
5. Make and review changes in the autosaved workspace draft.
6. Open **Printers** and explicitly apply the draft when it is ready for the physical machine.

A starter creates an editable draft with example files and variables. It does not connect to hardware, create applied history, or claim that a printer uses those files.

To create a printer:

1. Open **Klipper Workspace** or **Printers**.
2. Choose the **+** button beside Printer.
3. Select a starter that matches the printer's kinematics, or choose a custom printer when you will import an existing configuration.
4. Enter a recognisable printer name and description.
5. Confirm the new printer.

The workspace has three main areas: **Printer and Configuration Files** on the left select the active printer and file; the editor in the centre holds an autosaved working draft; and **Workspace tools** below the editor contains Review, Docs, Package, Variables, Versions, and Install actions.

## Choose a setup

- For browser based editing and configuration lifecycle tasks, see [Configuration workspace](../guides/configuration-workspace.md).
- To synchronize from a printer host or desktop, see [Desktop and printer integration](../guides/desktop-and-printer.md).
- To run a private server, follow [Self-hosting](../operations/self-hosting.md).

> [!CAUTION]
> Printer configuration can move hardware or energise heaters. Review pins, thermistors, motion limits, included files, and rendered variables for the exact printer target before applying configuration. Klippee creates backups and asks before overwrites, but it does not make an unreviewed configuration safe.
