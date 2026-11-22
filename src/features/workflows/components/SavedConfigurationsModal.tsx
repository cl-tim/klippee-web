import { Alert, Button, Group, Paper, Stack, Text } from "@mantine/core";
import { RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cloudFetch } from "../../../app/cloudFetch";
import { formatDate } from "../../../app/format";
import { ModalShell } from "../../../components/ModalShell";
import { configurationDeleteBlock, parseSavedConfigurations, type SavedConfiguration } from "../savedConfigurations";

export function SavedConfigurationsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <ModalShell onClose={onClose} open={open} title="Saved configurations">
      {open && <SavedConfigurationsContent />}
    </ModalShell>
  );
}

function SavedConfigurationsContent() {
  const [configs, setConfigs] = useState<SavedConfiguration[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [selected, setSelected] = useState<SavedConfiguration | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const active = useRef(false);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const invoker = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(() => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const requestGeneration = ++generation.current;
    let failure = "Couldn't load saved configurations. Please retry.";
    return cloudFetch("/api/repos?manage=1", {
      signal: abort.signal,
      validate: parseSavedConfigurations,
      onStatus: (status) => { failure = status; },
      messages: { fail: failure, error: failure },
    }).then(result => {
      if (!active.current || requestGeneration !== generation.current) return;
      if (result.ok && result.data) setConfigs(result.data.repositories);
      else setError(failure);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    active.current = true;
    void load();
    return () => {
      active.current = false;
      controller.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    if (deleting) return;
    if (selected) cancelRef.current?.focus();
    else if (invoker.current?.isConnected) invoker.current.focus();
    else if (invoker.current) refreshRef.current?.focus();
  }, [selected, deleting]);

  function reload() {
    setLoading(true);
    setError("");
    return load();
  }

  async function remove(config: SavedConfiguration) {
    setDeleting(true);
    setError("");
    setNotice("");
    let failure = "Couldn't confirm deletion. Refresh the list before trying again.";
    const result = await cloudFetch(`/api/repos/${encodeURIComponent(config.id)}`, {
      method: "DELETE",
      json: { updatedAt: config.updated_at, latestVersionId: config.latest_version_id },
      onStatus: (status) => { failure = status; },
      messages: { fail: failure, error: failure },
      validate: (raw) => typeof raw === "object" && raw !== null
        && "ok" in raw && raw.ok === true && "deletedRepositoryId" in raw && raw.deletedRepositoryId === config.id
        ? { deletedRepositoryId: config.id } : null,
    });
    if (!active.current) return;
    setSelected(null);
    if (result.ok && result.data) {
      setConfigs(current => (current ?? []).filter(item => item.id !== config.id));
      setNotice(`Deleted “${config.title || config.name}” from Klippee. Printer files were not changed.`);
    } else {
      // A lost response may follow a committed deletion. Reload before offering
      // another attempt, and never treat a malformed success as confirmation.
      await reload();
      if (!active.current) return;
      setError(failure);
    }
    setDeleting(false);
  }

  return (
    <>
      <Text>Manage configuration copies saved in Klippee. Deleting one removes its draft and entire saved history. Files on your printers stay unchanged.</Text>
      <Group justify="space-between">
        <Text size="sm" c="dimmed">Configurations still linked to a printer or public listing are protected.</Text>
        <Button ref={refreshRef} loading={loading} disabled={loading || deleting || Boolean(selected)} leftSection={<RefreshCw size={15} />} onClick={() => void reload()} variant="subtle">Refresh</Button>
      </Group>
      {error && <Alert color="red" role="alert">{error}</Alert>}
      {notice && <Text role="status">{notice}</Text>}
      {loading && configs === null && <Text role="status">Loading saved configurations…</Text>}
      {!error && configs?.length === 0 && <Text>No saved configurations.</Text>}
      <Stack gap="sm" aria-busy={loading || deleting}>
        {(configs ?? []).map(config => {
          const label = config.title || config.name;
          const block = configurationDeleteBlock(config);
          const confirming = selected?.id === config.id;
          return (
            <Paper key={config.id} p="md" withBorder component="article" aria-label={label}>
              <Group justify="space-between" align="flex-start" wrap="wrap">
                <Stack gap={4} style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                  <Text fw={600}>{label}</Text>
                  {config.name !== label && <Text size="sm" c="dimmed">{config.name}</Text>}
                  <Text size="sm">{config.version_count} saved version{config.version_count === 1 ? "" : "s"}{config.pending_draft ? " · Draft saved" : ""}</Text>
                  <Text size="sm" c="dimmed">Updated {formatDate(config.updated_at)}</Text>
                  {block && <Text size="sm">{block}. Remove these links in Klippee before deleting.</Text>}
                </Stack>
                <Button aria-label={`Delete ${label}`} className="danger-action" color="red" disabled={loading || deleting || Boolean(selected) || Boolean(block)} leftSection={<Trash2 size={15} />} onClick={event => {
                  invoker.current = event.currentTarget;
                  setNotice("");
                  setSelected(config);
                }} variant="outline">Delete</Button>
              </Group>
              {confirming && <Stack mt="md" gap="sm" role="group" aria-label={`Confirm deletion of ${label}`}>
                <Text fw={600}>Permanently delete “{label}”?</Text>
                <Text>This removes all its saved versions and draft, revokes its cloud sync access, and removes any associated diagnostic uploads. This cannot be undone. Files on printers will not be changed.</Text>
                <Group>
                  <Button ref={cancelRef} disabled={deleting} onClick={() => setSelected(null)} variant="default">Cancel</Button>
                  <Button className="danger-action" color="red" loading={deleting} disabled={deleting} onClick={() => void remove(config)}>Delete saved configuration</Button>
                </Group>
              </Stack>}
            </Paper>
          );
        })}
      </Stack>
    </>
  );
}
