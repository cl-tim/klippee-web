import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { fetchState, stubApiRoutes } from "./appTestUtils";
import { resetAccountStorageForTests } from "../storage";

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: vi.fn((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  })),
});
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  fetchState.user = null;
  stubApiRoutes();
});

afterEach(async () => {
  cleanup();
  await resetAccountStorageForTests();
  vi.unstubAllGlobals();
});
