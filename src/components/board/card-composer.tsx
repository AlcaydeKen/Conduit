"use client";

import { useRef, useState } from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * An inline title-only composer, deliberately not a form.
 *
 * A card needs a title and a home; everything else — description, priority,
 * points, assignee, labels — is editable in the drawer the moment it exists.
 * Asking for all of it up front turns "write down the thing before you forget
 * it" into a form, which is the moment people stop using the board and go back
 * to a text file.
 *
 * It stays open after a successful create so several cards can be entered in a
 * row, which is how a backlog actually gets filled.
 */
export function CardComposer({
  label,
  onCreate,
}: {
  /** Names what is being added to, for the screen-reader label. */
  label: string;
  /** Resolves true when the card was created; false leaves the text in place. */
  onCreate: (title: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  async function submit() {
    const trimmed = title.trim();
    if (trimmed.length === 0 || busy) return;

    setBusy(true);
    const created = await onCreate(trimmed);
    setBusy(false);

    // Only clear on success. Losing someone's typing because a request failed
    // is worse than the failure itself.
    if (created) {
      setTitle("");
      inputRef.current?.focus();
    }
  }

  if (!open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground hover:text-foreground h-7 justify-start px-2 text-xs"
        onClick={() => {
          setOpen(true);
          // The ref is null until the textarea renders, so focus waits a frame.
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        aria-label={`Add a card to ${label}`}
      >
        <Plus className="size-3.5" />
        Add card
      </Button>
    );
  }

  return (
    <div className="space-y-1.5">
      <Textarea
        ref={inputRef}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          // Enter submits; Shift+Enter is a newline, since a title occasionally
          // wants one and muscle memory expects the modifier to escape.
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setTitle("");
            setOpen(false);
          }
        }}
        placeholder="Card title — Enter to add, Escape to close"
        aria-label={`New card title for ${label}`}
        rows={2}
        className="resize-none text-sm"
        disabled={busy}
      />
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => void submit()}
          disabled={busy || title.trim().length === 0}
        >
          {busy ? "Adding…" : "Add"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => {
            setTitle("");
            setOpen(false);
          }}
          disabled={busy}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
