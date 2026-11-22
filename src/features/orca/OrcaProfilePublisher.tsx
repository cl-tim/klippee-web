import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Anchor, Badge, Button, Checkbox, Group, Modal, NativeSelect, Stack, Switch, Text, Textarea, TextInput } from "@mantine/core";
import { cloudFetch } from "../../app/cloudFetch";
import { FieldHelp, FieldLabel } from "../../components/FieldHelp";
import type { CompanionAsset } from "../../types";
import { scanOrcaPublication, type OrcaPublicationReview, type OrcaPublicationSettings } from "./orcaPublication";

export function OrcaProfilePublisher({ profileId, onClose, onPublished }: {
  profileId: string; onClose: () => void; onPublished: () => void;
}) {
  const review = useQuery({ queryKey: ["orca-publication-review", profileId], gcTime: 0, staleTime: Infinity, retry: false,
    queryFn: async ({ signal }) => {
      const result = await cloudFetch<{ review: OrcaPublicationReview; error?: string }>(`/api/orca/library/publication?profileId=${encodeURIComponent(profileId)}`, { signal });
      if (!result.ok || !result.data?.review) throw new Error(result.data?.error ?? "Could not load this profile for review. Close this window and try again.");
      return result.data.review;
    } });
  return <Modal opened onClose={onClose} title="Publish Orca profile" size="lg" closeButtonProps={{ "aria-label": "Close publication review" }}>
    {review.isPending ? <Text role="status">Preparing the public copy…</Text> : review.error ? <Text role="alert">{review.error.message}</Text>
      : <PublicationForm review={review.data} profileId={profileId} onPublished={onPublished} onClose={onClose} />}
  </Modal>;
}

function PublicationForm({ review, profileId, onPublished, onClose }: {
  review: OrcaPublicationReview; profileId: string; onPublished: () => void; onClose: () => void;
}) {
  const fieldId = useId();
  const [title, setTitle] = useState(review.title);
  const [description, setDescription] = useState(review.description);
  const [confirmed, setConfirmed] = useState(false), [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false), [status, setStatus] = useState("");
  const [publicUrl, setPublicUrl] = useState(review.publicUrl), [removing, setRemoving] = useState(false);
  const [automatic, setAutomatic] = useState(review.autoUpdateEnabled ?? false);
  const [autoError, setAutoError] = useState(review.autoUpdateError ?? null);
  const [configSlug, setConfigSlug] = useState(review.printerConfig?.slug ?? "");
  const findings = [...review.findings, ...scanOrcaPublication({ title, description })];
  const blocked = findings.some(finding => finding.severity === "block");
  async function publish() {
    setBusy(true); setStatus("");
    const result = await cloudFetch<{ asset: CompanionAsset }>("/api/orca/library/publication", { method: "POST",
      json: { profileId, importId: review.importId, candidateHash: review.candidateHash, title, description,
        confirmPublic: confirmed, acknowledgeSafetyWarnings: acknowledged, autoUpdateEnabled: automatic, printerConfigSlug: configSlug || null }, onStatus: setStatus,
      messages: { error: "Could not connect. Try again." } });
    if (result.ok && result.data?.asset.publicUrl) { setPublicUrl(result.data.asset.publicUrl); setAutoError(null); setStatus("Published. Anyone with the link can download this profile."); onPublished(); }
    setBusy(false);
  }
  async function updateSettings(enabled: boolean, slug: string) {
    if (!publicUrl) { setAutomatic(enabled); setConfigSlug(slug); return; }
    setBusy(true); setStatus("");
    const result = await cloudFetch<{ publication: OrcaPublicationSettings }>("/api/orca/library/publication", {
      method: "PATCH", json: { profileId, autoUpdateEnabled: enabled, printerConfigSlug: slug || null }, onStatus: setStatus,
      messages: { error: "Could not save publication settings. Try again." } });
    if (result.ok && result.data?.publication) {
      const saved = result.data.publication;
      setAutomatic(saved.autoUpdateEnabled); setAutoError(saved.autoUpdateError); setConfigSlug(saved.printerConfig?.slug ?? "");
      if (!saved.autoUpdateError) setStatus("Publication settings saved.");
      onPublished();
    }
    setBusy(false);
  }
  async function unpublish() {
    setBusy(true);
    const result = await cloudFetch(`/api/orca/library/publication?profileId=${encodeURIComponent(profileId)}`, {
      method: "DELETE", onStatus: setStatus, messages: { error: "Could not connect. Try again." } });
    setBusy(false);
    if (result.ok) { onPublished(); onClose(); }
  }
  return <Stack gap="md">
    <Text size="sm">Share this saved profile and its inherited settings in Shared Configs. Review custom G-code and identifying details before publishing.</Text>
    <TextInput label="Public name" value={title} maxLength={160} required onChange={event => setTitle(event.currentTarget.value)} />
    <div><FieldLabel label="Description" htmlFor={`${fieldId}-description`}>Describe the printer, material and use this profile was tuned for.</FieldLabel>
      <Textarea id={`${fieldId}-description`} value={description} maxLength={4000} autosize minRows={2} maxRows={5} onChange={event => setDescription(event.currentTarget.value)} /></div>
    <div><FieldLabel label="Related printer config" htmlFor={`${fieldId}-config`}>Choose your published configuration that supplies this profile's macros. Changes to this link save immediately for published profiles.</FieldLabel>
    <NativeSelect id={`${fieldId}-config`}
      value={configSlug} disabled={busy} onChange={event => void updateSettings(automatic, event.currentTarget.value)}
      data={[{ value: "", label: "No printer config linked" }, ...(review.printerConfigs ?? []).map(config => ({ value: config.slug, label: config.title }))]} /></div>
    <Group justify="space-between" wrap="nowrap" gap="xs">
      <Switch label="Automatically update after Orca re-imports" aria-label="Automatically update after Orca re-imports"
        checked={automatic} disabled={busy} onChange={event => void updateSettings(event.currentTarget.checked, configSlug)} />
      <FieldHelp label="Automatically update after Orca re-imports">Update this listing from the latest saved profile and future imports. Findings can pause updates for review.</FieldHelp>
    </Group>
    {autoError && <Text role="status" size="sm">{autoError}</Text>}
    {automatic && autoError && <Button variant="default" disabled={busy} onClick={() => void updateSettings(true, configSlug)}>Retry automatic update</Button>}
    <Group gap="xs">{review.tags.map(tag => <Badge key={tag} variant="light" style={{ maxWidth: "100%" }}>{tag}</Badge>)}</Group>
    <details><summary>Review the exact profile and inherited settings</summary><pre style={{ maxHeight: 320, overflow: "auto", fontSize: 12 }}>{review.content}</pre></details>
    {!!findings.length && <Stack gap="xs"><Text fw={600}>Review findings</Text>
      <ul>{findings.map((finding, index) => <li key={index}>{finding.severity === "block" ? "Blocked: " : ""}{finding.message}</li>)}</ul>
      {blocked ? <Text size="sm">Remove credentials from the listing, or correct the profile in OrcaSlicer and import it again before publishing.</Text>
        : <Checkbox label="I reviewed the warnings and accept them for this public profile." checked={acknowledged} onChange={event => setAcknowledged(event.currentTarget.checked)} />}
    </Stack>}
    <Checkbox label="I reviewed this profile and its ancestors and want anyone to be able to download them." checked={confirmed} onChange={event => setConfirmed(event.currentTarget.checked)} />
    {status && <Text role="status" size="sm">{status}</Text>}
    {publicUrl && <Group gap="xs"><Badge variant="light">Published</Badge><Anchor href={publicUrl} size="sm">View public listing</Anchor></Group>}
    <Group justify="space-between">
      {publicUrl ? <Button color="red" variant="subtle" disabled={busy || removing} onClick={() => setRemoving(true)}>Remove from Shared Configs</Button> : <span />}
      <Button loading={busy} disabled={!title.trim() || !confirmed || blocked || (!!findings.length && !acknowledged)} onClick={() => void publish()}>{publicUrl ? "Republish profile" : "Publish to Shared Configs"}</Button></Group>
    {publicUrl && removing && <Stack gap="xs" role="group" aria-label="Confirm Shared Configs removal">
      <Text size="sm">The public link will stop working. Your private profile is kept.</Text>
      <Group justify="flex-end"><Button variant="default" disabled={busy} onClick={() => setRemoving(false)}>Keep published</Button>
        <Button color="red" disabled={busy} onClick={() => void unpublish()}>Confirm removal</Button></Group>
    </Stack>}
  </Stack>;
}
