import { tabLabels } from "../../app/constants";
import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Badge, Button, Group, NativeSelect, Paper, SimpleGrid, Stack, Text, TextInput } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { Link } from "react-router";
import { apiError } from "../../lib/api";
import { PageHeader } from "../../components/common";
import type { PublicProfileSummary } from "./orcaPublication";

export function OrcaRegistryCatalog() {
  const [query, setQuery] = useState(""), [kind, setKind] = useState(""), [nozzle, setNozzle] = useState("");
  const [offset, setOffset] = useState(0), [search] = useDebouncedValue(query, 200);
  const profiles = useQuery({ queryKey: ["public-orca-profiles", search, kind, nozzle, offset],
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ q: search, kind, nozzle, offset: String(offset) });
      const response = await fetch(`/api/public-companion-assets?${params}`, { signal });
      if (!response.ok) throw new Error(await apiError(response, "Could not load shared Orca profiles."));
      return await response.json() as { assets: PublicProfileSummary[]; nextOffset: number | null; nozzleSizes: string[] };
    } });
  return <Stack gap="lg">
    <PageHeader title={tabLabels.Registry} help="Printer, filament and process profiles shared by the community. Publish yours from the Orca Workspace." />
    <SimpleGrid cols={{ base: 1, md: 3 }} style={{ alignItems: "end" }}><TextInput label="Search Orca profiles" placeholder="Name, material or printer" value={query} onChange={event => { setQuery(event.currentTarget.value); setOffset(0); }} />
      <NativeSelect label="Profile type" value={kind} onChange={event => { setKind(event.currentTarget.value); setOffset(0); }} data={[
        { value: "", label: "All profile types" }, { value: "machine", label: "Printer" }, { value: "filament", label: "Filament" }, { value: "process", label: "Process" }]} />
      <NativeSelect label="Nozzle size" value={nozzle} onChange={event => { setNozzle(event.currentTarget.value); setOffset(0); }} data={[
        { value: "", label: "All nozzle sizes" }, ...[...new Set([...(profiles.data?.nozzleSizes ?? []), ...(nozzle ? [nozzle] : [])])].map(size => ({ value: size, label: `${size} mm nozzle` }))]} />
    </SimpleGrid>
    {profiles.isPending ? <Text role="status">Loading shared profiles…</Text> : profiles.error ? <Stack><Text role="alert">{profiles.error.message}</Text><Button variant="default" onClick={() => void profiles.refetch()}>Try again</Button></Stack> : <>
      {!profiles.data.assets.length && <Text>No shared Orca profiles match these filters.</Text>}
      <div className="package-grid" aria-busy={profiles.isFetching}>{profiles.data.assets.map(asset => <Paper withBorder p="md" key={asset.publicSlug}><Stack gap="sm">
        <Text component="h2" fw={600} style={{ overflowWrap: "anywhere" }}>{asset.title}</Text><Text size="sm">{asset.description}</Text>
        <Group gap="xs"><Badge variant="light">{asset.kind === "machine" ? "Printer" : asset.kind === "filament" ? "Filament" : "Process"} profile · v{asset.version}</Badge>{asset.tags.map(tag => <Badge key={tag} variant="light" style={{ maxWidth: "100%" }}>{tag}</Badge>)}</Group>
        <Button component={Link} to={`/assets/${encodeURIComponent(asset.publicSlug ?? "")}`} variant="light">View profile</Button>
      </Stack></Paper>)}</div>
      {(offset > 0 || profiles.data.nextOffset !== null) && <Group><Button variant="default" disabled={offset === 0 || profiles.isFetching} onClick={() => setOffset(Math.max(0, offset - 24))}>Previous</Button>
        <Button variant="default" disabled={profiles.data.nextOffset === null || profiles.isFetching} onClick={() => setOffset(profiles.data.nextOffset ?? 0)}>Next</Button></Group>}
    </>}
    <Text size="sm" c="dimmed">Review every setting and custom G-code before use. Community profiles are not tested or endorsed by Klippee.</Text>
  </Stack>;
}
