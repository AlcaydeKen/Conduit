"use client";

import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
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
import type { BoardCard, CardComment } from "@/types/board";

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
};

const jobFetcher = async (url: string) => {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`job_fetch_failed_${response.status}`);
  return response.json() as Promise<{ job: AiJob | null }>;
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
  onClose,
  onCardChanged,
}: {
  cardId: number | null;
  card: BoardCard | null;
  onClose: () => void;
  /** Lets the board re-read once a job finishes. */
  onCardChanged?: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queueing, setQueueing] = useState(false);
  const [jobError, setJobError] = useState<string | null>(null);

  const { data, mutate } = useSWR(
    cardId ? `/api/v1/cards/${cardId}/comments` : null,
    fetcher,
  );

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
      await mutate();
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
          {card && card.labels.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {card.labels.map((label) => (
                <Badge
                  key={label.id}
                  className="text-[10px] text-white"
                  style={{ backgroundColor: label.color }}
                >
                  {label.name}
                </Badge>
              ))}
            </div>
          ) : null}

          {card?.description ? (
            <Prose>{card.description}</Prose>
          ) : (
            <p className="text-muted-foreground text-sm">No description yet.</p>
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
                <Prose>{draftText}</Prose>
              </div>
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
