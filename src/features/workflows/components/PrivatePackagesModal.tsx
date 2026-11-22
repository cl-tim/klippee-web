import { Alert, Button, Group, Paper, Stack, Text } from "@mantine/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { cloudFetch } from "../../../app/cloudFetch";
import { formatDate } from "../../../app/format";
import { ModalShell } from "../../../components/ModalShell";
import { parseManagedPrivatePackages, type ManagedPrivatePackage } from "../privatePackageManagement";

export function PrivatePackagesModal({ open, onClose, onDeleted }: {
  open: boolean; onClose: () => void; onDeleted: (id: string) => void;
}) {
  return <ModalShell open={open} onClose={onClose} title="Private packages">
    {open && <PrivatePackagesContent onDeleted={onDeleted} />}
  </ModalShell>;
}

function PrivatePackagesContent({ onDeleted }: { onDeleted: (id: string) => void }) {
  const [packages, setPackages] = useState<ManagedPrivatePackage[] | null>(null);
  const [selected, setSelected] = useState<ManagedPrivatePackage | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const active = useRef(false);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const lastSelected = useRef<string | null>(null);
  const deleteButtons = useRef(new Map<string, HTMLButtonElement>());

  const load = useCallback(() => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const requestGeneration = ++generation.current;
    let failure = "Couldn't load private packages. Please retry.";
    return cloudFetch("/api/private-packages?manage=1", {
      signal: abort.signal, validate: parseManagedPrivatePackages,
      messages: { fail: failure, error: failure }, onStatus: value => { failure = value; },
    }).then(result => {
      if (!active.current || requestGeneration !== generation.current) return;
      if (result.ok && result.data) setPackages(result.data.packages);
      else setError(failure);
      setLoading(false);
      return result.ok ? result.data?.packages : undefined;
    });
  }, []);

  useEffect(() => {
    active.current = true;
    void load();
    return () => { active.current = false; controller.current?.abort(); };
  }, [load]);

  useEffect(() => {
    if (deleting) return;
    if (selected) cancelRef.current?.focus();
    else if (lastSelected.current) (deleteButtons.current.get(lastSelected.current) ?? refreshRef.current)?.focus();
  }, [selected, deleting]);

  function reload() { setLoading(true); setError(""); return load(); }

  async function remove(pkg: ManagedPrivatePackage) {
    setDeleting(true); setError(""); setNotice("");
    let failure = "Couldn't confirm deletion. Refresh the list before trying again.";
    const result = await cloudFetch(`/api/private-packages/${encodeURIComponent(pkg.id)}`, {
      method: "DELETE", json: { updatedAt: pkg.updated_at },
      messages: { fail: failure, error: failure }, onStatus: value => { failure = value; },
      validate: raw => typeof raw === "object" && raw !== null && "ok" in raw && raw.ok === true
        && "deletedPackageId" in raw && raw.deletedPackageId === pkg.id ? { id: pkg.id } : null,
    });
    if (result.ok && result.data) onDeleted(pkg.id);
    if (!active.current) return;
    setSelected(null);
    if (result.ok && result.data) {
      setPackages(current => (current ?? []).filter(candidate => candidate.id !== pkg.id));
      setNotice(`Deleted “${pkg.title || pkg.name}”. Published copies and printer files were not changed.`);
    } else {
      const current = await reload();
      if (!active.current) return;
      if (current && !current.some(candidate => candidate.id === pkg.id)) onDeleted(pkg.id);
      setError(failure);
    }
    setDeleting(false);
  }

  if (selected) return <Stack role="group" aria-label={`Confirm deletion of ${selected.title || selected.name}`}>
    <Text fw={600} style={{ overflowWrap: "anywhere" }}>Permanently delete “{selected.title || selected.name}”?</Text>
    <Text>This removes the hosted private copy and its entry in this browser's package library. It cannot be undone.</Text>
    <Alert color="yellow">Published Shared Configs copies remain public. Deleting this private copy does not unpublish them. Printer files and saved configurations will not be changed.</Alert>
    <Group>
      <Button ref={cancelRef} disabled={deleting} onClick={() => setSelected(null)} variant="default">Cancel</Button>
      <Button className="danger-action" color="red" loading={deleting} disabled={deleting} onClick={() => void remove(selected)}>Delete private package</Button>
    </Group>
  </Stack>;

  return <>
    <Text>Remove obsolete private packages saved in Klippee. Packages bound to a printer in Klippee must be unbound first.</Text>
    <Group justify="space-between"><Text size="sm">Published Shared Configs copies are kept.</Text>
      <Button ref={refreshRef} loading={loading} disabled={loading || deleting} onClick={() => void reload()} variant="subtle">Refresh</Button>
    </Group>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    {notice && <Text role="status">{notice}</Text>}
    {loading && packages === null && <Text role="status">Loading private packages…</Text>}
    {!error && packages?.length === 0 && <Text>No hosted private packages.</Text>}
    <Stack gap="sm" aria-busy={loading || deleting}>
      {(packages ?? []).map(pkg => <Paper key={pkg.id} component="article" aria-label={pkg.title || pkg.name} p="md" withBorder>
        <Group justify="space-between" wrap="wrap" align="flex-start">
          <Stack gap={4} style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
            <Text fw={600}>{pkg.title || pkg.name}</Text>
            <Text size="sm">{pkg.name}</Text><Text size="sm" c="dimmed">Updated {formatDate(pkg.updated_at)}</Text>
            {pkg.published_listing_count > 0 && <Text size="sm">Published in Shared Configs; the public copy will remain available.</Text>}
            {pkg.linked_printer_count > 0 && <Text size="sm">Bound to a printer in Klippee. Unbind it before deleting.</Text>}
          </Stack>
          <Button ref={node => { if (node) deleteButtons.current.set(pkg.id, node); else deleteButtons.current.delete(pkg.id); }}
            aria-label={`Delete ${pkg.title || pkg.name}`} className="danger-action" color="red" variant="outline"
            disabled={loading || deleting || pkg.linked_printer_count > 0} onClick={() => {
              lastSelected.current = pkg.id; setNotice(""); setSelected(pkg);
            }}>Delete</Button>
        </Group>
      </Paper>)}
    </Stack>
  </>;
}
