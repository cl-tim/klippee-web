import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { cloudFetch } from "../cloudFetch";
import { parsePrinterPublicationCandidateResponse } from "../responseGuards";
import type { PrinterPublicationCandidate } from "../types";

type CandidateLoad = {
  candidate: PrinterPublicationCandidate | null;
  ok: boolean;
};

export function usePrinterPublicationCandidate(printerId: string | null, enabled = true) {
  const queryClient = useQueryClient();
  const { data, isFetching } = useQuery({
    enabled: Boolean(enabled && printerId),
    queryFn: async (): Promise<CandidateLoad> => {
      const result = await cloudFetch(
        `/api/printers/${encodeURIComponent(printerId ?? "")}/publication-candidate`,
        { validate: parsePrinterPublicationCandidateResponse },
      );
      // Failures are represented as data (ok: false) rather than a thrown
      // error so a failed load renders `failed` immediately instead of going
      // through the query client's retry policy.
      return {
        candidate: result.ok && result.data ? result.data.candidate : null,
        ok: Boolean(result.ok && result.data),
      };
    },
    queryKey: ["publication-candidate", printerId],
  });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["publication-candidate", printerId] });
  }, [printerId, queryClient]);

  // Mirrors the pre-query-library semantics: while a (re)fetch is in flight
  // the previous result is hidden, so consumers see `loading` instead of a
  // stale candidate; a disabled hook exposes nothing even if data is cached.
  const current = Boolean(enabled && printerId && !isFetching && data);
  return {
    candidate: current && data?.ok ? data.candidate : null,
    failed: Boolean(current && !data?.ok),
    loading: Boolean(enabled && printerId && isFetching),
    refresh,
  };
}
