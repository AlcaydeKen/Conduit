"use client";

import { useState } from "react";
import { Check, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { BoardLabel } from "@/types/board";

/**
 * Eight colours rather than a colour input.
 *
 * These render as chip backgrounds with white text, so a picker that allows any
 * hex allows unreadable ones — and nobody choosing `#fefefe` finds out until the
 * label is on a card. A fixed palette is one decision fewer and cannot produce
 * an unreadable chip. `POST /labels` still validates `#rrggbb`, so the API stays
 * general even though this UI is not.
 */
const PALETTE = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#a855f7",
  "#64748b",
];

export function LabelPicker({
  available,
  selected,
  workspaceId,
  onChange,
  onLabelCreated,
}: {
  /** Every label in the workspace, from the board payload. */
  available: BoardLabel[];
  selected: number[];
  workspaceId: number;
  /** Fires with the complete set; the API takes a set, not a delta. */
  onChange: (labelIds: number[]) => void;
  /** Lets the board refetch so a new label reaches the filter bar too. */
  onLabelCreated: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState(PALETTE[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createLabel() {
    const trimmed = name.trim();
    if (trimmed.length === 0 || busy) return;

    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/labels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId, name: trimmed, color }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(
          payload?.error === "label_exists"
            ? "That name is already taken."
            : "Could not create that label.",
        );
        return;
      }
      // Attach it immediately: creating a label from inside a card means you
      // wanted it on this card, and making that a second click is a small
      // insult to someone who already told you what they wanted.
      onChange([...selected, payload.label.id as number]);
      onLabelCreated();
      setName("");
      setCreating(false);
    } catch {
      setError("Could not create that label.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1">
        {available.map((label) => {
          const isOn = selected.includes(label.id);
          return (
            <button
              key={label.id}
              type="button"
              aria-pressed={isOn}
              onClick={() =>
                onChange(
                  isOn
                    ? selected.filter((id) => id !== label.id)
                    : [...selected, label.id],
                )
              }
            >
              <Badge
                className={cn(
                  "cursor-pointer gap-1 text-[10px] font-normal transition-opacity",
                  // Unselected labels stay recognisable by colour but read as
                  // off. Hiding them entirely would make the picker a list of
                  // what is already applied, which is the one thing the card
                  // face already shows.
                  !isOn && "opacity-40",
                )}
                style={{ backgroundColor: label.color, color: "white" }}
              >
                {isOn ? <Check className="size-3" /> : null}
                {label.name}
              </Badge>
            </button>
          );
        })}

        {available.length === 0 && !creating ? (
          <span className="text-muted-foreground text-xs">
            No labels in this workspace yet.
          </span>
        ) : null}

        {creating ? null : (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground h-6 px-1.5 text-xs"
            onClick={() => setCreating(true)}
          >
            <Plus className="size-3" />
            New
          </Button>
        )}
      </div>

      {creating ? (
        <div className="space-y-2 rounded-md border p-2">
          <div className="flex items-center gap-2">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void createLabel();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setName("");
                  setCreating(false);
                }
              }}
              placeholder="Label name"
              aria-label="New label name"
              maxLength={60}
              className="h-7 text-sm"
              autoFocus
              disabled={busy}
            />
            <Button
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => void createLabel()}
              disabled={busy || name.trim().length === 0}
            >
              {busy ? "Adding…" : "Add"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => {
                setName("");
                setCreating(false);
              }}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-1">
            {PALETTE.map((swatch) => (
              <button
                key={swatch}
                type="button"
                aria-label={`Use colour ${swatch}`}
                aria-pressed={color === swatch}
                onClick={() => setColor(swatch)}
                className={cn(
                  "size-5 rounded-full border-2 transition-transform",
                  color === swatch
                    ? "border-foreground scale-110"
                    : "border-transparent",
                )}
                style={{ backgroundColor: swatch }}
              />
            ))}
          </div>

          {error ? <p className="text-destructive text-xs">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
