import { Alert, Button, Code, Flex, Group, Stack, Text, TextInput, Title } from "@mantine/core";
import { ChevronDown, Search, TriangleAlert } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useAppShellContext } from "../app/contexts/useAppShellContext";
import { cn } from "../lib/utils";
import { Card, CardContent } from "./ui/card";
import { HelpRow } from "./FieldHelp";

export function PageHeader({ actions, className, help, title, titleId }: {
  actions?: ReactNode; className?: string; help?: ReactNode; title: ReactNode; titleId?: string;
}) {
  return (
    <Flex component="header" className={cn("page-header", className)} align="flex-start" justify="space-between" gap="lg" wrap="wrap">
      <Stack className="page-header-copy" gap="xs">
        {help ? <HelpRow label={typeof title === "string" ? title : "page"} help={help}><Title order={1} id={titleId}>{title}</Title></HelpRow>
          : <Title order={1} id={titleId}>{title}</Title>}
      </Stack>
      {actions ? <Group className="page-header-actions" gap="sm">{actions}</Group> : null}
    </Flex>
  );
}

export function SectionHeader({ action, className, help, title }: {
  action?: ReactNode; className?: string; help?: ReactNode; title: ReactNode;
}) {
  return (
    <Group className={cn("section-heading", className)} justify="space-between" gap="md" wrap="wrap">
      <Stack className="section-heading-copy" gap={4}>
        {help ? <HelpRow label={typeof title === "string" ? title : "section"} help={help}><Title order={2} size="h3">{title}</Title></HelpRow>
          : <Title order={2} size="h3">{title}</Title>}
      </Stack>
      {action}
    </Group>
  );
}

export function ActionGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <Group className={cn("action-group", className)} gap="sm" wrap="wrap">{children}</Group>;
}

export function SearchField({ className, ...props }: Omit<ComponentProps<"input">, "size"> & { className?: string }) {
  return <TextInput className={cn("search-box", className)} leftSection={<Search aria-hidden="true" size={18} />} type="search" {...props} />;
}

export function EmptyPanel({ children, message, title }: {
  children?: ReactNode; message?: string; title: string;
}) {
  return (
    <Card className="empty-panel"><CardContent>
      <Stack gap="lg"><PageHeader title={title} />{message ? <Text role="alert">{message}</Text> : null}{children}</Stack>
    </CardContent></Card>
  );
}

export function RiskWarning({ collapsible = false, title, warnings }: { collapsible?: boolean; title: string; warnings: string[] }) {
  const content = <ul role="list">{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>;
  if (collapsible) {
    return (
      <details className="risk-warning risk-warning-disclosure">
        <summary>
          <TriangleAlert aria-hidden="true" size={20} />
          <span>{title}</span>
          <ChevronDown aria-hidden="true" className="risk-warning-chevron" size={18} />
        </summary>
        {content}
      </details>
    );
  }
  return (
    <Alert className="risk-warning" color="yellow" icon={<TriangleAlert size={20} />} title={title} role="note"
      styles={{ root: { flexShrink: 0, background: "rgba(240, 199, 106, 0.07)", border: "1px solid rgba(240, 199, 106, 0.25)" }, title: { color: "var(--warning)" }, icon: { color: "var(--warning)" } }}>
      {content}
    </Alert>
  );
}

export function CodePreview({ label, value }: { label: string; value: string }) {
  return <Stack className="code-preview" gap="xs"><Text size="sm" c="dimmed">{label}</Text><Code block>{value}</Code></Stack>;
}

export function StatusBlock({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <Card className="status-block"><CardContent>
      <Stack gap="xs"><Text size="sm" c="dimmed">{label}</Text><Text fw={600}>{value}</Text><Text size="sm" c="dimmed">{detail}</Text></Stack>
    </CardContent></Card>
  );
}

export function AuthRequiredPanel() {
  const { authChecked, authStatus, setLoginOpen } = useAppShellContext();
  return (
    <div className="auth-required-panel">
      <Card className="auth-required-card" aria-labelledby="auth-required-title"><CardContent>
        <Stack gap="lg">
          <PageHeader title="Sign in required" titleId="auth-required-title" />
          <Group className="auth-required-actions" gap="md">
            <Button disabled={!authChecked} onClick={() => setLoginOpen(true)}>{authChecked ? "Sign in" : authStatus}</Button>
            <Text size="sm" c="dimmed">{authStatus}</Text>
          </Group>
        </Stack>
      </CardContent></Card>
    </div>
  );
}
