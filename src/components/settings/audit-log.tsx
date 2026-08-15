"use client";

import { useState } from "react";
import useSWR from "swr";

import {
  ActorCell,
  activityFetcher,
  describeAction,
  payloadSummary,
  toneOf,
} from "@/components/activity/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function AuditLog({ workspaceId }: { workspaceId: number }) {
  // Each page is its own SWR key, so going back is instant and no page is
  // refetched just because a later one was loaded.
  const [cursors, setCursors] = useState<(number | null)[]>([null]);
  const before = cursors[cursors.length - 1];

  const { data, isLoading } = useSWR(
    `/api/v1/activity?workspace=${workspaceId}&limit=50${
      before ? `&before=${before}` : ""
    }`,
    activityFetcher,
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
