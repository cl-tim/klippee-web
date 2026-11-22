import { Group, Switch } from "@mantine/core";
import { FieldHelp } from "../../../components/FieldHelp";
import { usePublicPackageApprovalStatus } from "../../../app/hooks/usePublicPackageApprovalStatus";
import { WorkflowButton } from "../WorkflowControls";

export function RegistryAutoUpdateSettings({ packageId, showPublicationProblem = true }: { packageId: string; showPublicationProblem?: boolean }) {
  const { status, setAutoUpdate, savingAutoUpdate, autoUpdateSaveError } = usePublicPackageApprovalStatus(packageId);
  if (!status?.linked) return null;
  return (
    <section aria-label="Automatic updates to Shared Configs" className="registry-auto-update-settings">
      <Group justify="space-between" wrap="nowrap" gap="xs"><Switch
        aria-label="Automatically update this shared listing"
        checked={status.autoUpdateEnabled}
        disabled={savingAutoUpdate}
        label="Automatically update this shared listing"
        onChange={(event) => setAutoUpdate(event.currentTarget.checked)}
      />
        <FieldHelp label="Automatically update this shared listing">Publish the current applied configuration, then follow future printer applies and captures. Draft edits stay private. Safety checks may pause an update.</FieldHelp>
      </Group>
      {showPublicationProblem && status.autoUpdateError ? (
        <div role="status">
          <p>{status.autoUpdateError}</p>
          <WorkflowButton disabled={savingAutoUpdate} onClick={() => setAutoUpdate(true)} type="button">Retry automatic update</WorkflowButton>
        </div>
      ) : null}
      {autoUpdateSaveError ? <p role="alert">{autoUpdateSaveError}</p> : null}
    </section>
  );
}
