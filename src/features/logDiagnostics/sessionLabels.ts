import type { KlippySession } from "./types";

type SessionLabelInput = Pick<KlippySession, "number" | "reason" | "wallTime">;

export function describeSession(sessions: SessionLabelInput[], number: number) {
  const index = sessions.findIndex((session) => session.number === number);
  if (index < 0) return "";
  const session = sessions[index];
  if (session.reason === "start of file" && !session.wallTime) return "log starts mid-session";
  if (sessions.length === 1) return "only detected session";
  if (index === 0) return "earliest detected";
  if (index === sessions.length - 1) return "latest detected";
  return "";
}

export function formatSessionLabel(sessions: SessionLabelInput[], number: number) {
  const description = describeSession(sessions, number);
  return `Session ${number}${description ? ` · ${description}` : ""}`;
}
