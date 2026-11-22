import { tabLabels } from "../../app/constants";
import { PageHeader } from "../../components/common";
import { useCallback, useEffect, useState } from "react";
import { Anchor, Badge, Button, Checkbox, Group, Menu, NativeSelect, Paper, SimpleGrid, Stack, Tabs, Text, TextInput } from "@mantine/core";
import { MoreActions } from "../../components/MoreActions";
import { cloudFetch } from "../../app/cloudFetch";
import { FieldHelp } from "../../components/FieldHelp";
import { useAppShellContext } from "../../app/contexts/useAppShellContext";
import { usePrinterContext } from "../../app/contexts/usePrinterContext";
import type { CaptureKind, OrcaLibrarySummary, OrcaSetupSummary } from "./orcaCapture";
import { orcaLibraryProfiles } from "./orcaLibraryPresentation";
import { orcaProfileTags, orcaProfileTagLabels } from "./orcaProfileTags";
import { OrcaProfilePublisher } from "./OrcaProfilePublisher";

const groups: Array<{ kind: CaptureKind; label: string }> = [
  { kind: "machine", label: "Printer profiles" }, { kind: "filament", label: "Custom filaments" }, { kind: "process", label: "Custom processes" },
];
type OrcaDevice = { id: string; createdAt: string; lastUsedAt: string; uploadsEnabled: boolean };

type Grant = { id: string; code: string; expiresAt: string; mode: "library" | "setup" | "restore" };

export function OrcaConnectionPanel() {
  const { authUser } = useAppShellContext();
  const { printers } = usePrinterContext();
  const [library, setLibrary] = useState<OrcaLibrarySummary | null>(null);
  const [devices, setDevices] = useState<OrcaDevice[]>([]);
  const [setups, setSetups] = useState<OrcaSetupSummary[]>([]);
  const [grant, setGrant] = useState<Grant | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [nozzleFilter, setNozzleFilter] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<string | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    const [profiles, saved, connections] = await Promise.all([
      cloudFetch<{ library: OrcaLibrarySummary | null }>("/api/orca/library", { signal }),
      cloudFetch<{ setups: OrcaSetupSummary[] }>("/api/orca/setups", { signal }),
      cloudFetch<{ devices: OrcaDevice[] }>("/api/orca/devices", { signal }),
    ]);
    if (signal?.aborted || !profiles.ok || !profiles.data || !saved.ok || !saved.data || !connections.ok || !connections.data) return null;
    return { devices: Array.isArray(connections.data?.devices) ? connections.data.devices : [], library: profiles.data.library ?? null, setups: Array.isArray(saved.data.setups) ? saved.data.setups : [] };
  }, []);
  const refresh = useCallback(async (signal?: AbortSignal, pending?: Grant) => {
    const loaded = await load(signal);
    if (signal?.aborted) return;
    setLoading(false);
    if (!loaded) { setStatus("Could not load your library. Choose Reload library to try again."); return; }
    setLibrary(loaded.library); setSetups(loaded.setups); setDevices(loaded.devices);
    if (pending && (loaded.devices.some((device) => device.id === pending.id) || loaded.library?.id === pending.id || loaded.setups.some((setup) => setup.id === pending.id))) {
      setGrant(null); setStatus(pending.mode === "restore" ? "OrcaSlicer connected. No new code is needed after restarts." : pending.mode === "library" ? "Profiles imported into your library." : "Current setup saved.");
    }
  }, [load]);
  useEffect(() => {
    if (!authUser) return;
    const controller = new AbortController();
    void load(controller.signal).then((loaded) => {
      if (controller.signal.aborted) return;
      setLoading(false);
      if (loaded) { setLibrary(loaded.library); setSetups(loaded.setups); setDevices(loaded.devices); }
      else setStatus("Could not load your library. Choose Reload library to try again.");
    });
    return () => controller.abort();
  }, [authUser, load]);
  useEffect(() => {
    if (!grant) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      if (Date.now() >= Date.parse(grant.expiresAt)) { setGrant(null); setStatus("Code expired. Create another code when ready."); }
      else void refresh(controller.signal, grant);
    }, 3000);
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [grant, refresh]);
  async function connect(mode: Grant["mode"]) {
    setBusy(true);
    const result = await cloudFetch<Omit<Grant, "mode">>(mode === "library" ? "/api/orca/connection" : mode === "restore" ? "/api/orca/pair-connection" : "/api/orca/setup-connection", {
      method: "POST", json: {}, onStatus: setStatus, messages: { fail: "Could not create a code.", error: "Connection failed. Try again." },
    });
    if (result.ok && result.data?.code) { setGrant({ ...result.data, mode }); setStatus(""); }
    setBusy(false);
  }
  function requestUpload(mode: "library" | "setup") {
    if (!devices.length) { void connect(mode); return; }
    const action = mode === "library" ? "Review profile import" : "Review current setup";
    setStatus(devices.some((device) => device.uploadsEnabled)
      ? `In Orca's Klippee page, choose ${action}, then confirm the upload. Your saved connection is used; no code is needed.`
      : `Enable Allow profile imports and setup saves below, then choose ${action} in Orca's Klippee page. No new pairing code is needed.`);
  }
  async function cancel() {
    if (!grant) return;
    setBusy(true);
    const result = await cloudFetch(`/api/orca/connections/${encodeURIComponent(grant.id)}`, { method: "DELETE", onStatus: setStatus });
    if (result.ok) { setGrant(null); setStatus("Code cancelled."); } setBusy(false);
  }
  async function allowUploads(id: string, uploadsEnabled: boolean) {
    setBusy(true);
    const result = await cloudFetch(`/api/orca/devices/${encodeURIComponent(id)}`, { method: "PUT", json: { uploadsEnabled }, onStatus: setStatus });
    if (result.ok) { await refresh(); setStatus(uploadsEnabled ? "Imports and setup saves enabled. Review each upload in the plugin before confirming." : "Uploads disabled. Already-reviewed uploads were cancelled; browsing and restoring remain available."); }
    setBusy(false);
  }
  async function disconnectDevice(id: string) {
    setBusy(true);
    const result = await cloudFetch(`/api/orca/devices/${encodeURIComponent(id)}`, { method: "DELETE", onStatus: setStatus });
    if (result.ok) { await refresh(); setStatus("Orca installation disconnected. Its saved profiles are kept."); }
    setBusy(false);
  }
  async function link(profileId: string, printerId: string, linked: boolean) {
    setBusy(true);
    const result = await cloudFetch("/api/orca/profile-printers", { method: "PUT", json: { profileId, printerId, linked }, onStatus: setStatus,
      messages: { fail: "Could not update printer link.", error: "Connection failed. Try again." } });
    if (result.ok) { await refresh(); setStatus(linked ? "Printer linked to profile." : "Printer link removed. Profile kept in your library."); } setBusy(false);
  }
  async function remove(id: string) {
    setBusy(true);
    const result = await cloudFetch(`/api/orca/setups/${encodeURIComponent(id)}`, { method: "DELETE", onStatus: setStatus });
    if (result.ok) { setDeleting(null); await refresh(); setStatus("Saved setup removed."); } setBusy(false);
  }
  const visibleProfiles = orcaLibraryProfiles(library?.profiles ?? []).map(profile => {
    const tags = orcaProfileTags(profile);
    return { ...profile, tags, tagLabels: orcaProfileTagLabels(tags) };
  });
  const nozzleSizes = [...new Set(visibleProfiles.flatMap(profile => profile.tags.nozzleSizes))].sort((a, b) => Number(a) - Number(b));
  const filteredProfiles = visibleProfiles.filter(profile =>
    (!nozzleFilter || (nozzleFilter === "unknown" ? profile.tags.nozzleScope === "unknown"
      : profile.tags.nozzleSizes.includes(nozzleFilter) || profile.tags.nozzleScope === "unrestricted"))
    && `${profile.displayName} ${profile.name} ${profile.tagLabels.join(" ")} ${printers.filter(printer => profile.printerIds.includes(printer.id)).map(printer => printer.name).join(" ")}`
      .toLowerCase().includes(query.trim().toLowerCase()));
  return <Paper withBorder p="md" mb="md"><Stack gap="lg">
    {publishing && <OrcaProfilePublisher profileId={publishing} onClose={() => setPublishing(null)} onPublished={() => void refresh()} />}
    <PageHeader title={tabLabels.Slicer} help="Nozzle variants stay separate. Browse and restore directly inside OrcaSlicer, or link profiles to physical printers when useful." actions={<><Button variant="default" disabled={!authUser || busy || !!grant} onClick={() => void connect("restore")}>{devices.length ? "Connect another Orca installation" : "Browse library in OrcaSlicer"}</Button><Button disabled={!authUser || busy || !!grant} onClick={() => requestUpload("library")}>{devices.length ? "Import in the Orca plugin" : "Import from OrcaSlicer"}</Button></>} />
    {status && <Text role="status" size="sm">{status}</Text>}
    {grant && <Paper withBorder p="md"><Stack gap="sm">
      <Text fw={600}>{grant.mode === "restore" ? "Browse and restore inside OrcaSlicer" : grant.mode === "library" ? "Import your profiles" : "Save your current setup"}</Text>
      <Text size="sm">{grant.mode === "restore" ? "In plugin 1.5.0 or later, paste this code under Browse your Klippee library once. The code expires after 10 minutes, but the paired Orca installation stays connected until you disconnect it below or in the plugin. It starts with browsing and restoring; enable imports and saves under Connected Orca installations when needed." : "Open Klippee in OrcaSlicer, paste this code, then review and confirm. Profile imports require plugin 1.2.0 or later. The code expires after 10 minutes."}</Text>
      <TextInput label={grant.mode === "restore" ? "Library access code" : "Import code"} type="password" value={grant.code} readOnly autoComplete="off" onFocus={(event) => event.currentTarget.select()} />
      <Group><Button variant="default" onClick={() => {
        void navigator.clipboard.writeText(grant.code).then(() => setStatus("Code copied. Paste it into the Klippee plugin in OrcaSlicer."))
          .catch(() => setStatus("Select and copy the import code above."));
      }}>Copy code</Button><Button variant="subtle" disabled={busy} onClick={() => void cancel()}>Cancel code</Button></Group>
      <Text size="sm" role="status">{grant.mode === "restore" ? "New connections start read-only. Imports and setup saves need a separate permission enabled below. The plugin never controls a printer." : "Waiting for OrcaSlicer. This library updates automatically after you confirm there."}</Text>
    </Stack></Paper>}
    <Group gap="sm" justify="space-between" wrap="nowrap"><Text size="sm" c="dimmed" style={{ minWidth: 0, overflowWrap: "anywhere" }}>{library ? `Imported ${new Date(library.updatedAt).toLocaleString()} · OrcaSlicer ${library.hostVersion}` : "No profiles imported yet"}</Text>
      <MoreActions label="Library actions" disabled={!authUser || busy}>
        <Menu.Item onClick={() => void refresh(undefined, grant ?? undefined)}>Reload library</Menu.Item>
        {library && <Menu.Item component="a" href="/api/orca/library/export">Export library backup</Menu.Item>}
      </MoreActions>
    </Group>
    <details><summary>Connected Orca installations ({devices.length})</summary><Stack gap="xs" mt="sm">
      <Text size="sm">Connections are remembered until disconnected. Enable uploads per installation to import profiles and save setups after review in the plugin. No connection to your physical printer is created.</Text>
      {!devices.length && <Text size="sm">No Orca installations connected yet.</Text>}
      {devices.map((device) => <Group key={device.id} justify="space-between"><Text size="sm">Orca · Connected {new Date(device.createdAt).toLocaleString()} · Last used {new Date(device.lastUsedAt).toLocaleString()}</Text>
        <Checkbox label="Allow profile imports and setup saves" aria-label={`Allow imports and saves for Orca connected ${new Date(device.createdAt).toLocaleString()}`} checked={!!device.uploadsEnabled} disabled={busy} onChange={(event) => void allowUploads(device.id, event.currentTarget.checked)} />
        <Button variant="subtle" color="red" disabled={busy} onClick={() => void disconnectDevice(device.id)} aria-label={`Disconnect Orca connected ${new Date(device.createdAt).toLocaleString()}`}>Disconnect</Button></Group>)}
    </Stack></details>
    {loading ? <Text role="status">Loading your library…</Text> : <>
      {!library && <Text size="sm">Import once from the plugin to bring in all enabled printer profiles and every custom filament and process, with their inheritance. No physical printer needs to be selected.</Text>}
      <SimpleGrid cols={{ base: 1, xs: 2 }} style={{ alignItems: "end" }}>
        <TextInput label="Search profiles" placeholder="Name, material, layer height or printer" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        <NativeSelect label="Nozzle size" value={nozzleFilter} onChange={event => setNozzleFilter(event.currentTarget.value)}
          data={[{ value: "", label: "All nozzle sizes" }, ...nozzleSizes.map(size => ({ value: size, label: `${size} mm nozzle` })), { value: "unknown", label: "Nozzle unspecified" }]} />
      </SimpleGrid>
      <Tabs className="orca-profile-tabs" defaultValue="machine"><Tabs.List>{groups.map((group) => <Tabs.Tab key={group.kind} value={group.kind}>{group.label} ({filteredProfiles.filter((profile) => profile.kind === group.kind).length})</Tabs.Tab>)}</Tabs.List>
        {groups.map((group) => {
          const profiles = filteredProfiles.filter(profile => profile.kind === group.kind);
          return <Tabs.Panel key={group.kind} value={group.kind} pt="md"><Stack gap="xs">
            {!profiles.length && <Text size="sm" c="dimmed">{query || nozzleFilter ? "No matching profiles." : `No ${group.label.toLowerCase()} imported yet.`}</Text>}
            {profiles.map((profile) => <Paper withBorder p="sm" key={profile.id}><details>
              <summary style={{ cursor: "pointer", overflowWrap: "anywhere" }}><strong>{profile.displayName}</strong>{profile.tagLabels.map(tag => <Badge key={tag} ml="xs" my={3} variant="light" style={{ maxWidth: "100%" }}>{tag}</Badge>)}
                <Text component="span" size="sm" c="dimmed"> · {profile.sourceLabel}{profile.printerIds.length ? ` · ${printers.filter((printer) => profile.printerIds.includes(printer.id)).map((printer) => printer.name).join(", ")}` : ""}</Text>
              </summary><Stack gap="xs" mt="sm">
                <Group gap="xs">
                  <Group gap={4} wrap="nowrap">
                    <Button component="a" variant="default" href={`/api/orca/library/profile-export?profileId=${encodeURIComponent(profile.id)}`} aria-label={`Export profile for OrcaSlicer: ${profile.displayName}`}>Export profile</Button>
                    <FieldHelp label={`Export ${profile.displayName} for OrcaSlicer`}>Export this profile, then open the JSON file under Restore from Klippee in Orca. Requires plugin 1.3.0. Restores a separate copy and its ancestors; your current selections stay unchanged.</FieldHelp>
                  </Group>
                  <Button variant="light" disabled={busy} onClick={() => setPublishing(profile.id)} aria-label={`${profile.publicUrl ? "Shared Configs settings" : "Publish to Shared Configs"}: ${profile.displayName}`}>{profile.publicUrl ? "Shared Configs settings" : "Publish to Shared Configs"}</Button>
                </Group>
                {profile.publicUrl && <Group gap="xs"><Badge variant="light">{profile.autoUpdateEnabled ? "Automatic updates" : "Manual updates"}</Badge>
                  <Anchor href={profile.publicUrl} size="sm">View public listing</Anchor></Group>}
                {profile.autoUpdateError && <Text size="sm" role="status">{profile.autoUpdateError}</Text>}
                {profile.printerConfig && <Anchor href={`/packages/${encodeURIComponent(profile.printerConfig.slug)}`} size="sm" style={{ overflowWrap: "anywhere" }}>Printer config: {profile.printerConfig.title}</Anchor>}
                {(profile.kind === "machine" || profile.displayName !== profile.name || profile.parentDisplayName) && <details><summary>{profile.kind === "machine" ? "Profile details and printer links" : "Profile details"}</summary><Stack gap="xs" mt="xs">
                {profile.displayName !== profile.name && <Text size="sm" c="dimmed" style={{ overflowWrap: "anywhere" }}>Orca preset name: {profile.name}</Text>}
                {profile.parentDisplayName && <Text size="sm">Inherits from: {profile.parentDisplayName}</Text>}
                {profile.kind === "machine" && <><Group justify="space-between" wrap="nowrap"><Text size="sm" fw={600}>Physical printers (optional)</Text>
                  <FieldHelp label={`Physical printers for ${profile.displayName}`}>A link is for organisation. It does not connect to the device or restrict where this profile can be used.</FieldHelp></Group>
                  {!printers.length && <Text size="sm">You can add a physical printer later. This profile is already saved.</Text>}
                  {printers.map((printer) => <Checkbox key={printer.id} label={printer.name} checked={profile.printerIds.includes(printer.id)} disabled={busy} onChange={(event) => void link(profile.id, printer.id, event.currentTarget.checked)} />)}
                </>}
                </Stack></details>}
              </Stack></details></Paper>)}
          </Stack></Tabs.Panel>;
        })}
      </Tabs>
    </>}
    <details><summary>Saved setups ({setups.length})</summary><Stack gap="sm" mt="sm">
      <Text size="sm">Snapshots of a selected printer profile, process and ordered filament slots, including captured unsaved edits. These are separate from your profile library.</Text>
      <Button variant="default" disabled={!authUser || busy || !!grant} onClick={() => requestUpload("setup")}>{devices.length ? "Save setup in the Orca plugin" : "Save current setup from OrcaSlicer"}</Button>
      {setups.map((setup) => <Paper withBorder p="sm" key={setup.id}><details>
        <summary style={{ cursor: "pointer", overflowWrap: "anywhere" }}><strong>{setup.title}</strong> · {new Date(setup.createdAt).toLocaleString()}</summary>
        <Stack gap="xs" mt="sm"><ul>{setup.selections.map((item, index) => <li key={index}>{item.kind === "filament" ? `Filament ${(item.slot ?? 0) + 1}` : item.kind === "machine" ? "Printer profile" : "Process"}: {item.name}{item.dirty ? " (includes unsaved changes)" : ""}</li>)}</ul>
          <Text size="sm">Export this setup, then open the JSON file under Restore from Klippee in the Orca plugin. It restores separate preset copies and lists the selections for each filament slot.</Text>
          <Group><Button component="a" href={`/api/orca/setups/${encodeURIComponent(setup.id)}`} variant="default">Export saved setup</Button><Button color="red" variant="subtle" disabled={busy} onClick={() => setDeleting(setup.id)}>Remove saved setup</Button></Group>
          {deleting === setup.id && <Group><Text size="sm">Remove this Klippee copy?</Text><Button color="red" disabled={busy} onClick={() => void remove(setup.id)}>Confirm removal</Button><Button variant="subtle" onClick={() => setDeleting(null)}>Keep setup</Button></Group>}
        </Stack></details></Paper>)}
    </Stack></details>
    <details><summary>Plugin installation and help</summary><Stack gap="xs" mt="sm">
      <Text size="sm">Version 1.6.0 uses your saved connection to browse, restore, import profiles and save setups, with a review before every upload. Requires OrcaSlicer 2.5.0-alpha. Install the downloaded Python file in Orca's Plugins manager and enable Klippee.</Text>
      <Button component="a" href="/install/klippee_orca.py" download variant="default">Download Orca plugin</Button>
      <Text size="sm">The plugin copies profiles when you confirm an import. A paired plugin remembers its connection. Uploads require the permission enabled for that installation. It does not sync automatically. It does not connect to or control your physical printer.</Text>
      <Text size="sm">Import again after changing profiles in Orca. This replaces the library backup; saved setups and optional printer links are kept. Your current setup and captured unsaved edits are included in the backup. Connection credentials are excluded.</Text>
    </Stack></details>
  </Stack></Paper>;
}
