import { useCallback, useEffect, useRef, useState } from "react";

const defaultResetMs = 1800;

/**
 * Clipboard copy with uniform transient feedback: `copied` flips true after a
 * successful write and resets automatically after `resetMs` (~1.8s).
 */
export function useCopyFeedback(resetMs = defaultResetMs) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const copy = useCallback(async (text: string) => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      timerRef.current = window.setTimeout(() => {
        setCopied(false);
        timerRef.current = null;
      }, resetMs);
      return true;
    } catch {
      setCopied(false);
      return false;
    }
  }, [resetMs]);

  return { copied, copy };
}
