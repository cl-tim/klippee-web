import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import { packages } from "./data";
import { accountStorageKey } from "./storage";
import {
  fetchState,
  getAccountStored,
  jsonResponse,
  setAccountStored,
  stubApiRoutes,
} from "./test/appTestUtils";

describe("App shell", () => {
  it("renders the brand, primary tabs, and the support link", async () => {
    render(<App />);

    expect(await screen.findByLabelText("Klippee navigation")).toHaveTextContent("Klippee");
    expect(screen.getByRole("link", { name: "Klipper Workspace" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Orca Workspace" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Shared Configs" })).toHaveAttribute("href", "/shared-configs");
    expect(screen.getByRole("link", { name: "Log Diagnostics" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Gridfinity Editor" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "OpenGrid Editor" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "OpenGrid Underware Editor" })).toBeInTheDocument();

    const support = screen.getByRole("link", { name: /support me/i });
    expect(support).toHaveAttribute("href", "https://ko-fi.com/tquinn");
  });

  it("gates a protected tab behind sign-in when signed out", async () => {
    render(<App />);

    // Default tab is Setup, which is protected; with no signed-in user the auth gate shows.
    expect(await screen.findByText("Sign in required")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sign in required" })).toBeInTheDocument();
  });

  it("opens the shared local workspace without showing browser account controls", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Local workspace", id: "self-hosted-user", providers: [], mode: "local" };
    window.history.pushState(null, "", "/printers");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Printers", exact: true })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sign in required" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Login" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Signed in user" })).not.toBeInTheDocument();
  });

  it("lets anyone browse the Shared Configs without signing in", async () => {
    render(<App />);

    await userEvent.click(await screen.findByRole("link", { name: "Shared Configs" }));

    expect(await screen.findByRole("heading", { name: "Shared Configs", exact: true })).toBeInTheDocument();
    expect(screen.queryByText("Sign in required")).not.toBeInTheDocument();
  });

  it.each([
    "/registry",
    "/registry/?tag=voron&tag=corexy#community",
    "/registry?type=orca#profiles",
  ])("redirects legacy catalog URL %s without losing filters or adding history", async (path) => {
    window.history.pushState(null, "", path);
    const original = new URL(window.location.href);
    const historyLength = window.history.length;

    render(<App />);

    await waitFor(() => expect(window.location.pathname).toBe("/shared-configs"));
    expect(window.location.search).toBe(original.search);
    expect(window.location.hash).toBe(original.hash);
    expect(window.history.length).toBe(historyLength);
    expect(await screen.findByRole("heading", { name: "Shared Configs", exact: true })).toBeInTheDocument();
  });

  it("lets anyone open local log diagnostics without signing in", async () => {
    render(<App />);

    await userEvent.click(await screen.findByRole("link", { name: "Log Diagnostics" }));

    expect(await screen.findByRole("heading", { name: "Log Diagnostics" })).toBeInTheDocument();
    expect(screen.getByText("Browser analysis")).toBeInTheDocument();
    expect(screen.queryByText("Sign in required")).not.toBeInTheDocument();
  });

  it("opens a feature directly from its URL path", async () => {
    window.history.pushState(null, "", "/log-diagnostics");

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Log Diagnostics" })).toBeInTheDocument();
    expect(screen.queryByText("Sign in required")).not.toBeInTheDocument();
  });

  it("normalizes unknown URLs through the router", async () => {
    window.history.pushState(null, "", "/not-a-klippee-feature");

    render(<App />);

    await waitFor(() => expect(window.location.pathname).toBe("/klipper-configs"));
    expect(await screen.findByText("Sign in required")).toBeInTheDocument();
  });

  it("updates the URL path when switching features", async () => {
    window.history.pushState(null, "", "/");

    render(<App />);

    await userEvent.click(await screen.findByRole("link", { name: "Shared Configs" }));

    expect(window.location.pathname).toBe("/shared-configs");
    expect(await screen.findByRole("heading", { name: "Shared Configs", exact: true })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("link", { name: "Log Diagnostics" }));

    expect(window.location.pathname).toBe("/log-diagnostics");
    expect(await screen.findByRole("heading", { name: "Log Diagnostics" })).toBeInTheDocument();
  });

  it("returns to the top when switching features", async () => {
    window.history.pushState(null, "", "/shared-configs");

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Shared Configs", exact: true })).toBeInTheDocument();
    document.documentElement.scrollTop = 640;
    document.body.scrollTop = 640;
    const main = screen.getByRole("main");
    main.scrollTop = 640;

    await userEvent.click(screen.getByRole("link", { name: "Log Diagnostics" }));

    expect(await screen.findByRole("heading", { name: "Log Diagnostics" })).toBeInTheDocument();
    expect(document.documentElement.scrollTop).toBe(0);
    expect(main.scrollTop).toBe(0);
    expect(document.body.scrollTop).toBe(0);
    expect(main).toHaveFocus();
  });

  it("returns focus to the mobile navigation button on Escape", async () => {
    render(<App />);
    const toggle = await screen.findByRole("button", { name: "Open navigation menu" });
    await userEvent.click(toggle);
    screen.getByRole("link", { name: "Shared Configs" }).focus();
    await userEvent.keyboard("{Escape}");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
  });

  it("toggles the primary navigation from the mobile menu button", async () => {
    render(<App />);

    const menuButton = await screen.findByRole("button", { name: "Open navigation menu" });
    const shellNav = screen.getByLabelText("Klippee navigation");

    expect(menuButton).toHaveAttribute("aria-expanded", "false");
    expect(shellNav).not.toHaveClass("is-menu-open");

    await userEvent.click(menuButton);

    expect(screen.getByRole("button", { name: "Close navigation menu" })).toHaveAttribute("aria-expanded", "true");
    expect(shellNav).toHaveClass("is-menu-open");

    await userEvent.click(await screen.findByRole("link", { name: "Shared Configs" }));

    expect(screen.getByRole("button", { name: "Open navigation menu" })).toHaveAttribute("aria-expanded", "false");
    expect(shellNav).not.toHaveClass("is-menu-open");
    expect(window.location.pathname).toBe("/shared-configs");
  });

  it("collapses and pins the desktop app menu", async () => {
    render(<App />);

    const shellNav = await screen.findByLabelText("Klippee navigation");
    const shell = document.querySelector(".app-shell");
    const collapseButton = screen.getByRole("button", { name: "Collapse app menu" });
    const unpinButton = screen.getByRole("button", { name: "Unpin app menu" });

    expect(shell).not.toHaveClass("is-navigation-collapsed");
    expect(shellNav).toHaveClass("is-pinned");
    expect(unpinButton).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(collapseButton);

    expect(shell).toHaveClass("is-navigation-collapsed");
    expect(shellNav).toHaveClass("is-collapsed");
    expect(JSON.parse(localStorage.getItem("klippee.mvp.appNavigationExpanded") ?? "null")).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Expand app menu" }));
    await userEvent.click(screen.getByRole("button", { name: "Unpin app menu" }));

    expect(shellNav).not.toHaveClass("is-pinned");
    expect(screen.getByRole("button", { name: "Pin app menu" })).toHaveAttribute("aria-pressed", "false");
    expect(JSON.parse(localStorage.getItem("klippee.mvp.appNavigationPinned") ?? "null")).toBe(false);

    await userEvent.click(await screen.findByRole("link", { name: "Shared Configs" }));

    expect(shell).toHaveClass("is-navigation-collapsed");
    expect(shellNav).toHaveClass("is-collapsed");
  });

  it("responds to browser history navigation between feature paths", async () => {
    window.history.pushState(null, "", "/shared-configs");

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Shared Configs", exact: true })).toBeInTheDocument();

    window.history.pushState(null, "", "/log-diagnostics");
    window.dispatchEvent(new PopStateEvent("popstate"));

    expect(await screen.findByRole("heading", { name: "Log Diagnostics" })).toBeInTheDocument();
  });

  it("shows protected workspace content once signed in", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };

    render(<App />);

    // Setup is protected; a signed-in user without a printer is routed to printer management.
    expect(await screen.findByRole("heading", { name: "Choose a printer for this workspace" })).toBeInTheDocument();
    expect(screen.queryByText("Sign in required")).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("Primary")).getAllByRole("link")[0]).toHaveTextContent("Printers");
    await userEvent.click(screen.getByRole("button", { name: "Open Printers" }));
    expect(await screen.findByRole("heading", { name: "Printers" })).toBeInTheDocument();
  });

  it("does not mount account state until authentication has resolved", async () => {
    const legacySecret = "legacy-unknown-owner-secret";
    localStorage.setItem("klippee.mvp.workspaceContent", JSON.stringify(legacySecret));
    let resolveAuth!: (response: Response) => void;
    const authResponse = new Promise<Response>((resolve) => {
      resolveAuth = resolve;
    });
    stubApiRoutes((url) => {
      if (url.includes("/api/auth/me")) return authResponse;
      if (url.endsWith("/api/app-state")) return jsonResponse({ state: null, updatedAt: null });
      if (url.includes("/api/private-packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/companion-assets")) return jsonResponse({ assets: [] });
      if (url.includes("/api/printers")) return jsonResponse({ printers: [] });
      if (url.includes("/api/packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/repos")) return jsonResponse({ repositories: [] });
      return jsonResponse({});
    });

    render(<App />);

    expect(screen.getByRole("heading", { name: "Loading Klippee" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Klippee navigation")).not.toBeInTheDocument();
    expect(screen.queryByText(legacySecret)).not.toBeInTheDocument();

    await act(async () => {
      resolveAuth(jsonResponse({
        user: { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] },
      }));
    });

    expect(await screen.findByLabelText("Klippee navigation")).toBeInTheDocument();
    expect(localStorage.getItem(accountStorageKey("u1", "workspaceContent"))).toBeNull();
    expect(localStorage.getItem("klippee.mvp.workspaceContent")).toBeNull();
  });

  it("keeps the signed-in identity when logout fails and remounts anonymous state only after success", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    let logoutSucceeds = false;
    stubApiRoutes((url) => {
      if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
      if (url.includes("/api/auth/logout")) {
        return logoutSucceeds
          ? jsonResponse({ ok: true })
          : jsonResponse({ error: "Session cleanup failed" }, 500);
      }
      if (url.endsWith("/api/app-state")) return jsonResponse({ state: null, updatedAt: null });
      if (url.includes("/api/private-packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/companion-assets")) return jsonResponse({ assets: [] });
      if (url.includes("/api/printers")) return jsonResponse({ printers: [] });
      if (url.includes("/api/packages")) return jsonResponse({ packages: [] });
      if (url.includes("/api/repos")) return jsonResponse({ repositories: [] });
      return jsonResponse({});
    });

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /^Account menu for Tester / }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    expect(await screen.findByText("Sign-out failed; still signed in")).toBeInTheDocument();
    expect(screen.getByText("Tester")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Login" })).not.toBeInTheDocument();

    logoutSucceeds = true;
    await userEvent.click(screen.getByRole("button", { name: /^Account menu for Tester / }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));

    expect(await screen.findByRole("button", { name: "Login" })).toBeInTheDocument();
    expect(await screen.findByText("Sign in required")).toBeInTheDocument();
  });

  it("shows linked providers and linking actions in the account menu", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: ["github"] };
    render(<App />);

    const account = await screen.findByRole("button", { name: /^Account menu for Tester / });
    await userEvent.click(account);
    const menu = await screen.findByRole("menu", { name: /^Account menu for Tester / });

    expect(within(menu).getByLabelText("GitHub connected")).toHaveTextContent("Connected");
    expect(within(menu).queryByRole("menuitem", { name: "Link GitHub" })).not.toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Link Discord" })).toHaveAttribute("href", "/api/auth/discord/start");

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    await waitFor(() => expect(account).toHaveFocus());
  });

  it("replaces account-scoped package and companion caches with authoritative cloud results", async () => {
    fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
    setAccountStored("privatePackages", [{ ...packages[0], id: "cached-only-package" }]);
    setAccountStored("companionAssets", [{ id: "cached-only-asset", title: "Cached only asset" }]);

    render(<App />);

    await waitFor(() => {
      expect(getAccountStored("privatePackages", ["missing"])).toEqual([]);
      expect(getAccountStored("companionAssets", ["missing"])).toEqual([]);
    });
  });
});
