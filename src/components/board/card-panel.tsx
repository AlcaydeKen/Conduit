"use client";

import { useEffect, useState } from "react";
import { Archive, Loader2, Pencil, Sparkles, Undo2 } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import useSWR from "swr";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  ActorCell,
  activityFetcher,
  describeAction,
  toneOf,
} from "@/components/activity/shared";
import { CardEditForm } from "@/components/board/card-edit-form";
import { LabelPicker } from "@/components/board/label-picker";
import { cn } from "@/lib/utils";
import type { BoardCard, BoardLabel, CardComment, Person } from "@/types/board";

const fetcher = async (url: string) => {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`comments_fetch_failed_${response.status}`);
  return response.json() as Promise<{ comments: CardComment[] }>;
};

type AiJob = {
  id: number;
  kind: string;
  status: "pending" | "claimed" | "done" | "failed";
  result: unknown;
  error: string | null;
  attempts: number;
  /** The card title the job was generated from. Null on jobs queued before this existed. */
  source_title: string | null;
};

const jobFetcher = async (url: string) => {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`job_fetch_failed_${response.status}`);
  return response.json() as Promise<{ job: AiJob | null }>;
};

const membersFetcher = async (url: string) => {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`members_fetch_failed_${response.status}`);
  return response.json() as Promise<{ members: Person[] }>;
};

const IN_FLIGHT = new Set(["pending", "claimed"]);

/** The runner returns free-form JSON; pull out the text without assuming a shape. */
function draftTextOf(result: unknown): string | null {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const text = (result as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return null;
}

/**
 * react-markdown escapes raw HTML unless `rehype-raw` is added. It deliberately
 * is not — comment bodies are user input rendered to other users.
 */
function Prose({ children }: { children: string }) {
  return (
    <div className="prose-sm max-w-none space-y-2 text-sm leading-relaxed [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs [&_li]:ml-4 [&_li]:list-disc [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2">
      <Markdown remarkPlugins={[remarkGfm]}>{children}</Markdown>
    </div>
  );
}

export function CardPanel({
  cardId,
  card,
  workspaceId,
  labels,
  onClose,
  onCardChanged,
}: {
  cardId: number | null;
  card: BoardCard | null;
  /** Explicit rather than inferred: the roster is per workspace. */
  workspaceId: number;
  /** Every label in the workspace, from the board payload. */
  labels: BoardLabel[];
  onClose: () => void;
  /** Lets the board re-read once a job finishes or the card is edited. */
  onCardChanged?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queueing, setQueueing] = useState(false);
  const [jobError, setJobError] = useState<string | null>(null);

  const { data, mutate } = useSWR(
    cardId ? `/api/v1/cards/${cardId}/comments` : null,
    fetcher,
  );

  // Only while the form is open. The roster changes about once a quarter and
  // there is no reason to fetch it for everyone who merely opens a card.
  const { data: memberData } = useSWR(
    editing ? `/api/v1/members?workspace=${workspaceId}` : null,
    membersFetcher,
  );

  /*
   * This card's history. Capped rather than paginated: the drawer answers "what
   * happened to this card recently", and the settings audit log is where you go
   * to page through everything.
   *
   * No `refreshInterval`. The two things that write history from inside this
   * panel — a comment and an edit — already revalidate on success, and the
   * board's 5s poll does not need a third timer behind it.
   */
  const { data: historyData, mutate: mutateHistory } = useSWR(
    cardId
      ? `/api/v1/activity?workspace=${workspaceId}&card=${cardId}&limit=25`
      : null,
    activityFetcher,
  );

  // Opening a different card must not inherit the previous one's edit mode —
  // the panel is one component reused for every card, so the state outlives the
  // card unless something clears it.
  useEffect(() => {
    setEditing(false);
    setConfirmArchive(false);
  }, [cardId]);

  /** The API takes the complete set, so both callers below send one. */
  async function patchCard(body: Record<string, unknown>): Promise<boolean> {
    if (!cardId) return false;
    const response = await fetch(`/api/v1/cards/${cardId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) return false;
    onCardChanged?.();
    void mutateHistory();
    return true;
  }

  async function archiveCard() {
    setArchiving(true);
    const done = await patchCard({ archived: true });
    setArchiving(false);
    setConfirmArchive(false);
    // Close on success: the card is off the board, and leaving its drawer open
    // over an empty board is a view of something that is no longer there.
    if (done) onClose();
  }

  /**
   * A flat interval, running whenever the drawer is open.
   *
   * Conditional versions — `refreshInterval` as a function of the latest data,
   * or the same number driven from state — are tempting, since a settled job
   * never changes again. Both are harder to reason about than they look: the
   * function form is evaluated when SWR arms its timer, and at mount there is
   * usually no job at all. A flat interval matches what the board already does
   * and has one behaviour rather than two.
   *
   * The cost is one small request every three seconds while a drawer is open —
   * one drawer at a time, and only while someone is looking at it. Closing the
   * drawer nulls the key, which is what actually stops it. As on the board,
   * SWR suspends the interval entirely while the tab is hidden.
   */
  const { data: jobData, mutate: mutateJob } = useSWR(
    cardId ? `/api/v1/ai/jobs?card=${cardId}` : null,
    jobFetcher,
    {
      refreshInterval: 3000,
      onSuccess: (latest) => {
        if (latest.job && !IN_FLIGHT.has(latest.job.status)) onCardChanged?.();
      },
    },
  );

  const job = jobData?.job ?? null;
  const jobRunning = job !== null && IN_FLIGHT.has(job.status);
  const draftText = job?.status === "done" ? draftTextOf(job.result) : null;

  /*
   * The draft was written from the card as it stood at enqueue, and a job can
   * outlive that — pending, then 2+ minutes generating, then up to three sweeps
   * and retries. Nothing stops a teammate renaming the card in that window.
   *
   * Comparing titles rather than re-running or discarding the draft: the
   * snapshot is doing what it is for, and the older draft is often still worth
   * reading. What was missing was any way to tell that from the drawer, where a
   * confident paragraph about the wrong subject reads as a broken model.
   *
   * Null `source_title` means a job queued before the field existed, which is
   * absence of evidence rather than evidence of a match — so it says nothing.
   */
  const staleTitle =
    draftText && job?.source_title && card && job.source_title !== card.title
      ? job.source_title
      : null;

  async function queueDraft() {
    if (!cardId) return;
    setQueueing(true);
    setJobError(null);
    try {
      const response = await fetch("/api/v1/ai/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ card_id: cardId, kind: "draft_card" }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setJobError(
          payload?.error === "job_already_queued"
            ? "A draft is already queued for this card."
            : "Could not queue that draft.",
        );
        return;
      }
      await mutateJob();
    } catch {
      setJobError("Could not queue that draft.");
    } finally {
      setQueueing(false);
    }
  }

  async function submitComment() {
    if (!cardId || draft.trim().length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/cards/${cardId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: draft.trim() }),
      });
      if (!response.ok) throw new Error(`comment_failed_${response.status}`);
      setDraft("");
      await Promise.all([mutate(), mutateHistory()]);
    } catch {
      setError("Could not post that comment.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet open={cardId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="pr-6 text-base leading-snug">
            {card?.title ?? "Card"}
          </SheetTitle>
          <SheetDescription>
            {card ? `#${card.id} · ${card.priority}` : null}
            {card?.points != null ? ` · ${card.points} pts` : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto px-4 pb-6">
          {card ? (
            <LabelPicker
              available={labels}
              selected={card.labels.map((label) => label.id)}
              workspaceId={workspaceId}
              /* Fire and revalidate rather than hold local state: the picker
                 renders from `card.labels`, which the board's poll refreshes,
                 so a failed request self-corrects on the next tick instead of
                 leaving the UI insisting on a label the server rejected. */
              onChange={(labelIds) => void patchCard({ label_ids: labelIds })}
              onLabelCreated={() => onCardChanged?.()}
            />
          ) : null}

          {card && editing ? (
            <CardEditForm
              card={card}
              members={memberData?.members ?? []}
              onSaved={() => {
                setEditing(false);
                onCardChanged?.();
                void mutateHistory();
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <div className="space-y-2">
              {card?.description ? (
                <Prose>{card.description}</Prose>
              ) : (
                <p className="text-muted-foreground text-sm">
                  No description yet.
                </p>
              )}
              {card ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditing(true)}
                  >
                    <Pencil className="size-3.5" />
                    Edit
                  </Button>

                  {/* Two steps, because archiving removes the card from every
                      board and the first click is one pixel from Edit. The
                      confirmation says where it goes, not just "are you sure" —
                      the reversibility is the reassurance. */}
                  {confirmArchive ? (
                    <>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => void archiveCard()}
                        disabled={archiving}
                      >
                        <Archive className="size-3.5" />
                        {archiving ? "Archiving…" : "Archive it"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirmArchive(false)}
                        disabled={archiving}
                      >
                        <Undo2 className="size-3.5" />
                        Keep it
                      </Button>
                      <span className="text-muted-foreground text-xs">
                        Off the board, not deleted — comments and history stay.
                      </span>
                    </>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setConfirmArchive(true)}
                    >
                      <Archive className="size-3.5" />
                      Archive
                    </Button>
                  )}
                </div>
              ) : null}
            </div>
          )}

          <section className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={queueDraft}
                disabled={queueing || jobRunning}
              >
                <Sparkles className="size-3.5" />
                {queueing ? "Queueing…" : "Generate AI draft"}
              </Button>

              {jobRunning ? (
                <Badge variant="secondary" className="gap-1.5 font-normal">
                  <Loader2 className="size-3 animate-spin" />
                  {/* "queued" and "running" are different waits, and the
                      difference is the first thing anyone asks about. */}
                  {job?.status === "pending" ? "Queued" : "Drafting"}
                </Badge>
              ) : null}

              {job?.status === "failed" ? (
                <Badge
                  variant="outline"
                  className="text-destructive border-destructive/40 font-normal"
                >
                  Draft failed
                </Badge>
              ) : null}
            </div>

            {jobRunning ? (
              <p className="text-muted-foreground text-xs">
                This runs on a worker that polls once a minute, so it will not
                be instant. You can close this panel and come back.
              </p>
            ) : null}

            {jobError ? (
              <p className="text-destructive text-xs">{jobError}</p>
            ) : null}

            {job?.status === "failed" && job.error ? (
              <p className="text-muted-foreground text-xs">{job.error}</p>
            ) : null}

            {draftText ? (
              <div className="bg-muted/40 space-y-1 rounded-md border p-3">
                <p className="text-muted-foreground text-xs font-medium">
                  AI draft — not applied to the card
                </p>
                {staleTitle ? (
                  <p className="text-muted-foreground text-xs italic">
                    Written from an earlier title: “{staleTitle}”
                  </p>
                ) : null}
                <Prose>{draftText}</Prose>
              </div>
            ) : null}
          </section>

          <Separator />

          <section className="space-y-2">
            <h4 className="text-sm font-medium">History</h4>
            <ul className="space-y-2">
              {historyData?.entries.map((entry) => (
                <li
                  key={entry.id}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
                >
                  <ActorCell actor={entry.actor} />
                  <Badge
                    variant="outline"
                    className={cn("font-normal", toneOf(entry.action))}
                  >
                    {describeAction(entry.action)}
                  </Badge>
                  <span className="text-muted-foreground tabular-nums">
                    {new Date(entry.created_at).toLocaleString()}
                  </span>
                </li>
              ))}
              {historyData && historyData.entries.length === 0 ? (
                <li className="text-muted-foreground text-xs">
                  Nothing recorded for this card yet.
                </li>
              ) : null}
            </ul>
            {historyData?.next_before ? (
              <p className="text-muted-foreground text-xs">
                {/* Says so rather than pretending 25 is all of it. */}
                Showing the 25 most recent — the full trail is in Settings.
              </p>
            ) : null}
          </section>

          <Separator />

          <section className="space-y-3">
            <h4 className="text-sm font-medium">
              Comments
              {data ? (
                <span className="text-muted-foreground ml-1 tabular-nums">
                  {data.comments.length}
                </span>
              ) : null}
            </h4>

            <ul className="space-y-4">
              {data?.comments.map((comment) => (
                <li key={comment.id} className="flex gap-3">
                  <Avatar className="mt-0.5 size-6 shrink-0">
                    {comment.author?.image ? (
                      <AvatarImage src={comment.author.image} alt="" />
                    ) : null}
                    <AvatarFallback className="text-[9px]">
                      {(comment.author?.name ?? "?").slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium">
                      {comment.author?.name ?? "Unknown"}
                      <span className="text-muted-foreground ml-2 font-normal">
                        {new Date(comment.created_at).toLocaleString()}
                      </span>
                    </p>
                    <Prose>{comment.body}</Prose>
                  </div>
                </li>
              ))}
              {data && data.comments.length === 0 ? (
                <li className="text-muted-foreground text-sm">
                  Nothing yet. Markdown works here.
                </li>
              ) : null}
            </ul>

            <div className="space-y-2">
              <Textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Write a comment — Markdown supported"
                rows={3}
              />
              {error ? (
                <p className="text-destructive text-xs">{error}</p>
              ) : null}
              <Button
                size="sm"
                onClick={submitComment}
                disabled={submitting || draft.trim().length === 0}
              >
                {submitting ? "Posting…" : "Comment"}
              </Button>
            </div>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
