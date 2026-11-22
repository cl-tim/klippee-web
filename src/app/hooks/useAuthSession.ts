import { useEffect, useState } from "react";
import { cloudFetch } from "../cloudFetch";
import { parseAuthMeResponse, parseLogoutResponse } from "../responseGuards";
import type { AuthUser } from "../types";

export type AuthSession = {
  authChecked: boolean;
  authStatus: string;
  authUser: AuthUser | null;
  cloudStatus: string;
  loginOpen: boolean;
  logout: () => Promise<boolean>;
  setCloudStatus: (status: string) => void;
  setLoginOpen: (open: boolean) => void;
};

/**
 * Owns the /api/auth/me probe and the logout call. Returns the resolved user
 * plus an authChecked flag once the probe completes, leaving downstream
 * "load X after sign-in" effects to the caller. Callers gate their loads on
 * `authChecked && authUser` to avoid implicit callback ordering.
 */
export function useAuthSession(): AuthSession {
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authStatus, setAuthStatus] = useState("Checking sign-in");
  const [cloudStatus, setCloudStatus] = useState("Sign in to save to cloud");
  const [loginOpen, setLoginOpen] = useState(false);

  useEffect(() => {
    let active = true;

    async function loadAuthUser() {
      const result = await cloudFetch("/api/auth/me", { validate: parseAuthMeResponse });
      if (!active) {
        return;
      }
      if (!result.ok || !result.data) {
        setAuthChecked(true);
        setAuthStatus("Sign-in unavailable");
        return;
      }
      setAuthUser(result.data.user);
      setAuthChecked(true);
      setAuthStatus(result.data.user ? "Signed in" : "Not signed in");
      setCloudStatus(result.data.user ? "Cloud save ready" : "Sign in to save to cloud");
    }

    void loadAuthUser();

    return () => {
      active = false;
    };
  }, []);

  async function logout() {
    const result = await cloudFetch("/api/auth/logout", {
      method: "POST",
      validate: parseLogoutResponse,
    });
    if (!result.ok || !result.data) {
      setAuthStatus("Sign-out failed; still signed in");
      return false;
    }
    setAuthUser(null);
    setAuthChecked(true);
    setAuthStatus("Not signed in");
    setCloudStatus("Sign in to save to cloud");
    return true;
  }

  return {
    authChecked,
    authStatus,
    authUser,
    cloudStatus,
    loginOpen,
    logout,
    setCloudStatus,
    setLoginOpen,
  };
}
