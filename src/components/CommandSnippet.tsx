import { Check, Clipboard } from "lucide-react";
import { ActionIcon } from "@mantine/core";
import { useCopyFeedback } from "../lib/useCopyFeedback";

export function CommandSnippet({ command, label }: { command: string; label: string }) {
  const { copied, copy } = useCopyFeedback();

  return (
    <div className="sync-command">
      <div>
        <strong>{label}</strong>
        <code>{command}</code>
      </div>
      <ActionIcon
        aria-label={`Copy ${label} command`}
        className="icon-button"
        onClick={() => void copy(command)}
        title="Copy command"
        type="button"
      >
        {copied ? <Check size={16} /> : <Clipboard size={16} />}
      </ActionIcon>
    </div>
  );
}
