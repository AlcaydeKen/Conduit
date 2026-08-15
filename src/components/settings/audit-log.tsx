"use client";

import { useState } from "react";
import useSWR from "swr";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { initialsOf } from "@/lib/board-filters";
import { cn } from "@/lib/utils";

type ResolvedActor =
  | { kind: "user"; id: string; name: string | null; image: string | null }
  | { kind: "key"; id: number; label: string | null; revoked: boolean }
  | { kind: "job"; id: number }
  | { kind: "unknown"; raw: string };

type Entry = {
  id: number;
  action: string;
  actor: ResolvedActor;
  card: { id: number; title: string | null } | null;
  payload: unknown;
  created_at: string;
};

type Page = { entries: Entry[]; next_before: number | null };

const fetcher = async (url: string): Promise<Page> => {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`activity_fetch_failed_${response.status}`);
  return response.json();
};

/**
 * Actions are `noun.verb`, or `ai.<kind>.<outcome>`. Rendering the raw string
 * would be honest but unreadable at a glance, and this table exists to be
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

function describeAction(action: string): string {
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
function toneOf(action: string): string | undefined {
  if (action.startsWith("api_key.")) {
    return "border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-400";
  }
  if (action.endsWith(".failed")) {
    return "border-destructive/40 text-destructive";
  }
  return undefined;
}

function ActorCell({ actor }: { actor: ResolvedActor }) {
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

function payloadSummary(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const entries = Object.entries(payload as Record<string, unknown>)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key.replace(/_/g, " ")}: ${String(value)}`);
  return entries.length > 0 ? entries.join(" · ") : null;
}

export function AuditLog({ workspaceId }: { workspaceId: number }) {
  // Each page is its own SWR key, so going back is instant and no page is
  // refetched just because a later one was loaded.
  const [cursors, setCursors] = useState<(number | null)[]>([null]);
  const before = cursors[cursors.length - 1];

  const { data, isLoading } = useSWR(
    `/api/v1/activity?workspace=${workspaceId}&limit=50${
      before ? `&before=${before}` : ""
    }`,
    fetcher,
    { keepPreviousData: true },
  );

  const entries = data?.entries ?? [];

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-medium">Audit log</h2>
        <p className="text-muted-foreground text-sm">
          Every change to this workspace, newest first, with who caused it. A
          machine action shows the key that made it — by id, because a key&apos;s
          label is chosen by whoever created it.
        </p>
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-muted-foreground text-left text-xs">
            <tr>
              <th className="px-3 py-2 font-medium whitespace-nowrap">When</th>
              <th className="px-3 py-2 font-medium">Who</th>
              <th className="px-3 py-2 font-medium">What</th>
              <th className="px-3 py-2 font-medium">Card</th>
              <th className="px-3 py-2 font-medium">Details</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id} className="border-t align-top">
                <td className="text-muted-foreground px-3 py-2 whitespace-nowrap tabular-nums">
                  {new Date(entry.created_at).toLocaleString()}
                </td>
                <td className="px-3 py-2">
                  <ActorCell actor={entry.actor} />
                </td>
                <td className="px-3 py-2">
                  <Badge
                    variant="outline"
                    className={cn("font-normal", toneOf(entry.action))}
                  >
                    {describeAction(entry.action)}
                  </Badge>
                </td>
                <td className="text-muted-foreground max-w-48 truncate px-3 py-2">
                  {entry.card ? (
                    <>
                      <span className="tabular-nums">#{entry.card.id}</span>{" "}
                      {entry.card.title}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="text-muted-foreground max-w-64 truncate px-3 py-2 text-xs">
                  {payloadSummary(entry.payload) ?? "—"}
                </td>
              </tr>
            ))}

            {entries.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="text-muted-foreground px-3 py-6 text-center text-xs"
                >
                  {isLoading ? "Loading…" : "Nothing recorded yet."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={cursors.length === 1}
          onClick={() => setCursors((stack) => stack.slice(0, -1))}
        >
          Newer
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!data?.next_before}
          onClick={() =>
            setCursors((stack) =>
              data?.next_before ? [...stack, data.next_before] : stack,
            )
          }
        >
          Older
        </Button>
        <span className="text-muted-foreground text-xs">
          page {cursors.length}
        </span>
      </div>
    </section>
  );
}
