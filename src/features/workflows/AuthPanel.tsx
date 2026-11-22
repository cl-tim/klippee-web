import { ArrowUpRight, Check, ChevronsUpDown, GitFork, LogOut, MessageCircle, UserCircle2 } from "lucide-react";
import { Avatar, Button, Group, Menu, Text, UnstyledButton } from "@mantine/core";
import { useAppShellContext } from "../../app/contexts/useAppShellContext";
import { ModalShell } from "../../components/ModalShell";
import classes from "./AuthPanel.module.css";

const providers = [
  { id: "github", label: "GitHub", Icon: GitFork },
  { id: "discord", label: "Discord", Icon: MessageCircle },
] as const;

export function AuthPanel() {
  const { authStatus, authUser, loginOpen, setLoginOpen, logout } = useAppShellContext();

  function onCloseLogin() {
    setLoginOpen(false);
  }

  if (authUser?.mode === "local") return null;

  if (authUser) {
    const linkedProviders = new Set(authUser.providers ?? []);

    return (
      <section className="auth-panel" aria-label="Signed in user">
        <Menu
          position="top-start"
          offset={8}
          width={260}
          styles={{
            dropdown: { maxWidth: "calc(100vw - 16px)" },
            item: { minHeight: 44, fontSize: "var(--text-body)" },
            label: { fontSize: "var(--text-secondary)", fontWeight: 600 },
          }}
        >
          <Menu.Target>
            <UnstyledButton
              className={classes.trigger}
              style={{
                display: "flex", alignItems: "center", gap: "var(--mantine-spacing-sm)", width: "100%",
                minHeight: "var(--account-height, 64px)", padding: "var(--account-padding, var(--mantine-spacing-xs))",
                border: "1px solid var(--account-border, var(--border))", borderRadius: "var(--mantine-radius-md)",
                background: "var(--account-background, var(--card))",
              }}
              title={authUser.displayName}
              type="button"
            >
              <span className="sr-only">Account menu for </span>
              <Avatar aria-hidden="true" src={authUser.avatarUrl} name={authUser.displayName} alt="" size={40} radius="xl" color="klippee" />
              <div className={classes.identity}>
                <Text fw={600} truncate>{authUser.displayName}</Text>
                <Text size="sm" c="dimmed">{authStatus}</Text>
              </div>
              <ChevronsUpDown className={classes.chevron} size={16} aria-hidden="true" />
            </UnstyledButton>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>Linked accounts</Menu.Label>
            {providers.map(({ id, label, Icon }) => linkedProviders.has(id) ? (
              <Group key={id} justify="space-between" gap="xs" wrap="nowrap" px="sm" mih={44} role="group" aria-label={`${label} connected`}>
                <Group gap="sm" wrap="nowrap"><Icon size={18} aria-hidden="true" /><Text>{label}</Text></Group>
                <Group gap={4} wrap="nowrap" c="klippee.3"><Check size={14} aria-hidden="true" /><Text size="sm">Connected</Text></Group>
              </Group>
            ) : (
              <Menu.Item
                key={id}
                component="a"
                href={`/api/auth/${id}/start`}
                aria-label={`Link ${label}`}
                leftSection={<Icon size={18} aria-hidden="true" />}
                rightSection={<Group gap={4} wrap="nowrap" c="klippee.3"><Text size="sm">Link</Text><ArrowUpRight size={14} aria-hidden="true" /></Group>}
              >{label}</Menu.Item>
            ))}
            <Menu.Divider />
            <Menu.Item className="sign-out-button" color="red" styles={{ item: { color: "var(--destructive)" } }} onClick={logout} leftSection={<LogOut size={18} aria-hidden="true" />}>
              Sign out
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </section>
    );
  }

  return (
    <>
      <Button aria-label="Login" className="login-button" onClick={() => setLoginOpen(true)} variant="default" fullWidth leftSection={<UserCircle2 size={17} />} type="button">
        <span>Login</span>
      </Button>
      <ModalShell
        closeLabel="Close login"
        onClose={onCloseLogin}
        open={loginOpen}
        sizeClass="login-modal"
        title="Login"
      >
        {authStatus !== "Not signed in" && <Text role="status">{authStatus}</Text>}
        <div className="provider-list">
          <Button component="a" href="/api/auth/github/start" variant="default" fullWidth>
            GitHub
          </Button>
          <Button component="a" href="/api/auth/discord/start" variant="default" fullWidth>
            Discord
          </Button>
        </div>
      </ModalShell>
    </>
  );
}
