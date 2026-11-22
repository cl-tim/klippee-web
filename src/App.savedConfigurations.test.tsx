import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { App } from "./App";
import { fetchState, jsonResponse, stubApiRoutes } from "./test/appTestUtils";

it("opens saved configurations from Printers even when the account has no printers", async () => {
  fetchState.user = { avatarUrl: null, displayName: "Tester", id: "u1", providers: [] };
  stubApiRoutes(url => {
    if (url.endsWith("/api/printers")) return jsonResponse({ printers: [] });
    if (url.endsWith("/api/repos?manage=1")) return jsonResponse({ repositories: [] });
  });
  render(<App />);
  await userEvent.click(await screen.findByRole("link", { name: "Printers" }));
  await screen.findByText("No printers yet");
  const opener = screen.getByRole("button", { name: "Saved configurations" });
  await userEvent.click(opener);
  await screen.findByRole("dialog", { name: "Saved configurations" });
  await screen.findByText("No saved configurations.");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(opener).toHaveFocus());
});
