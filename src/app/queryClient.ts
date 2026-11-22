import { QueryClient } from "@tanstack/react-query";

/**
 * Query client factory shared by the app root and test harnesses. Defaults are
 * deliberately conservative so query behavior matches the hand-rolled effects
 * these queries replaced: no focus refetching, at most one retry, and the
 * default `staleTime: 0` so re-enabling a query (e.g. reopening a modal)
 * refetches like the old effect-based loaders did.
 */
export function createAppQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  });
}
