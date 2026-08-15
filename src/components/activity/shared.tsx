"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { initialsOf } from "@/lib/board-filters";
import { cn } from "@/lib/utils";

/**
 * Everything two readers of `/api/v1/activity` must agree on: the settings
 * audit log and the card drawer's history.
 *
 * Shared rather than copied because `ActorCell` carries a rule, not a layout —
 * a key is always shown by id, never by label alone. A second copy is a second
 * place for that to be quietly relaxed by someone tidying up.
 */
export type ResolvedActor =
  | { kind: "user"; id: string; name: string | null; image: string | null }
  | { kind: "key"; id: number; label: string | null; revoked: boolean }
  | { kind: "job"; id: number }
  | { kind: "unknown"; raw: string };

export type ActivityEntry = {
  id: number;
  action: string;
  actor: ResolvedActor;
  card: { id: number; title: string | null } | null;
  payload: unknown;
  created_at: string;
};

export type ActivityPage = {
  entries: ActivityEntry[];
  next_before: number | null;
};

export const activityFetcher = async (url: string): Promise<ActivityPage> => {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`activity_fetch_failed_${response.status}`);
  return response.json();
};

/**
 * Actions are `noun.verb`, or `ai.<kind>.<outcome>`. Rendering the raw string
 * would be honest but unreadable at a glance, and these surfaces exist to be
 * scanned.
 */
const ACTION_LABELS: Record<string, string> = {
  "card.create": "created a card",
  "card.update": "edited a card",
  "card.move": "moved a card",
  "comment.create": "commented",
  "sprint.start": "started a sprint",
  "sprint.complete": "completed a sprint",
  "api_key.create": "created an API key",
  "api_key.revoke": "revoked an API key",
};

export function describeAction(action: string): string {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action];
  if (action.startsWith("ai.")) {
    const [, kind, outcome] = action.split(".");
    const verb =
      outcome === "queued"
        ? "queued"
        : outcome === "done"
          ? "finished"
          : "failed";
    return `${verb} an AI ${(kind ?? "").replace(/_/g, " ")} job`;
  }
  return action;
}

/** Tone by consequence, not by noun: key changes are the ones worth spotting. */
export function toneOf(action: string): string | undefined {
  if (action.startsWith("api_key.")) {
    return "border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-400";
  }
  if (action.endsWith(".failed")) {
    return "border-destructive/40 text-destructive";
  }
  return undefined;
}

export function payloadSummary(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const entries = Object.entries(payload as Record<string, unknown>)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key.replace(/_/g, " ")}: ${String(value)}`);
  return entries.length > 0 ? entries.join(" · ") : null;
}

export function ActorCell({ actor }: { actor: ResolvedActor }) {
  if (actor.kind === "user") {
    const name = actor.name ?? "Deleted user";
    return (
      <span className="flex items-center gap-2">
        <Avatar className="size-5">
          {actor.image ? <AvatarImage src={actor.image} alt="" /> : null}
          <AvatarFallback className="text-[9px]">
            {initialsOf(actor.name)}
          </AvatarFallback>
        </Avatar>
        <span className={cn(!actor.name && "text-muted-foreground italic")}>
          {name}
        </span>
      </span>
    );
  }

  if (actor.kind === "key") {
    /*
     * The id is shown next to the label, never the label alone. A label is free
     * text its creator chose, so one reading "Ana Diaz" must still be visibly a
     * key — that ambiguity is the reason the log stores `key:<id>` rather than
     * the name in the first place.
     */
    return (
      <span className="flex items-center gap-2">
        <Badge variant="outline" className="font-normal">
          key #{actor.id}
        </Badge>
        <span className="text-muted-foreground truncate">
          {actor.label ?? "deleted key"}
          {actor.revoked ? " · revoked" : ""}
        </span>
      </span>
    );
  }

  if (actor.kind === "job") {
    return (
      <Badge variant="outline" className="font-normal">
        AI job #{actor.id}
      </Badge>
    );
  }

  return <span className="text-muted-foreground font-mono">{actor.raw}</span>;
}
