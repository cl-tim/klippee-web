import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { cloudFetch } from "../cloudFetch";
import { parsePublicPackageApprovalStatusResponse } from "../responseGuards";
import type { PublicPackageApprovalStatus } from "../types";

export function usePublicPackageApprovalStatus(packageId: string | null, enabled = true) {
  const queryClient = useQueryClient();
  const { data, isPending, isError } = useQuery({
    enabled: Boolean(enabled && packageId),
    queryFn: async (): Promise<PublicPackageApprovalStatus> => {
      const result = await cloudFetch(`/api/public-packages/${encodeURIComponent(packageId ?? "")}/status`, {
        validate: parsePublicPackageApprovalStatusResponse,
      });
      if (!result.ok || !result.data) {
        // Throwing keeps the previously loaded status visible on a failed
        // refetch, matching the pre-query-library hook that only committed
        // successful responses.
        throw new Error(`Approval status load failed (status ${result.status})`);
      }
      return result.data.status;
    },
    queryKey: ["package-approval", packageId],
    // The original hook issued exactly one request per load; keep that.
    retry: false,
  });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["package-approval", packageId] });
  }, [packageId, queryClient]);

  const updateSetting = useMutation({
    mutationFn: async ({ enabled, id }: { enabled: boolean; id: string | null }) => {
      const result = await cloudFetch(`/api/public-packages/${encodeURIComponent(id ?? "")}/auto-update`, {
        json: { enabled },
        method: "PATCH",
        validate: parsePublicPackageApprovalStatusResponse,
      });
      if (!result.ok || !result.data) throw new Error("Could not save automatic updates to Shared Configs. Please retry.");
      return result.data.status;
    },
    onSuccess: (status, { id }) => {
      queryClient.setQueryData(["package-approval", id], status);
      void queryClient.invalidateQueries({ queryKey: ["package-catalog"] });
      void queryClient.invalidateQueries({ queryKey: ["shared-package", id] });
    },
  });

  return {
    refresh,
    loading: Boolean(enabled && packageId && isPending),
    failed: Boolean(enabled && packageId && isError),
    savingAutoUpdate: updateSetting.isPending,
    autoUpdateSaveError: updateSetting.error?.message ?? null,
    setAutoUpdate: (enabled: boolean) => updateSetting.mutate({ enabled, id: packageId }),
    status: data ?? null,
  };
}
