import { useRef } from "react";

/** Any callable — the widest function type every handler is assignable to. */
type AnyHandler = (...args: never[]) => unknown;

/**
 * Give a record of per-render closures stable identities.
 *
 * Returns an object with the same keys whose function identities never change
 * across renders; each call is forwarded to the implementation from the most
 * recent render. The latest-implementation ref is (re)assigned during render,
 * before children render, so a consumer that calls a handler while rendering
 * (e.g. `buildPrinterInstallCommand` in PrinterSyncPanel) always reaches this
 * render's closures — never a stale previous commit.
 *
 * The record must have the same keys on every render (a static object
 * literal at the call site guarantees this).
 */
export function useStableHandlers<T extends Record<string, AnyHandler>>(handlers: T): T {
  const latestRef = useRef(handlers);
  // Latest-ref pattern: deliberately (re)assigned in render (see the doc
  // comment) so same-pass child renders reach this render's closures. The
  // write is idempotent and never read to produce render output here.
  // eslint-disable-next-line react-hooks/refs
  latestRef.current = handlers;

  const stableRef = useRef<T | null>(null);
  if (stableRef.current === null) {
    const stable: Record<string, AnyHandler> = {};
    for (const key of Object.keys(handlers)) {
      stable[key] = ((...args: unknown[]) =>
        (latestRef.current[key] as (...forwarded: unknown[]) => unknown)(...args)) as AnyHandler;
    }
    stableRef.current = stable as T;
  }
  // Lazily-initialized constant: the same wrapper object on every render.
  // eslint-disable-next-line react-hooks/refs
  return stableRef.current;
}
