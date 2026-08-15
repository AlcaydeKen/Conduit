"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { PRIORITIES } from "@/lib/board-filters";
import type { BoardCard, Person, Priority } from "@/types/board";

/** base-ui's Select needs a value for every option; null is not one. */
const UNASSIGNED_VALUE = "unassigned";

export function CardEditForm({
  card,
  members,
  onSaved,
  onCancel,
}: {
  card: BoardCard;
  /** The workspace roster, so someone with no cards is still assignable. */
  members: Person[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description ?? "");
  const [priority, setPriority] = useState<Priority>(card.priority);
  const [points, setPoints] = useState(
    card.points === null ? "" : String(card.points),
  );
  const [assignee, setAssignee] = useState(
    card.assignee?.id ?? UNASSIGNED_VALUE,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * The values this edit started from, captured once.
   *
   * Deliberately a snapshot rather than a live read of `card`: the board polls
   * every five seconds, so `card` changes underneath an open form whenever
   * anyone else touches the row — another browser, or Claude Code over MCP.
   * Diffing against the live prop would make a teammate's edit look like your
   * own unchanged value and quietly stop being sent.
   *
   * The form does not remount while it is open (same element, same position),
   * so this stays fixed for the whole edit session, which is what makes it
   * meaningful.
   */
  const [initial] = useState(() => ({
    title: card.title,
    description: card.description ?? "",
    priority: card.priority,
    points: card.points === null ? "" : String(card.points),
    assignee: card.assignee?.id ?? UNASSIGNED_VALUE,
  }));

  /*
   * The roster may not contain the current assignee — someone can be removed
   * from `workspace_members` while still holding cards, since `assignee_id` is
   * `ON DELETE SET NULL` on the *user*, not on the membership. Without this the
   * select would silently show "Unassigned" and saving would quietly unassign
   * a card nobody meant to touch.
   */
  const options =
    card.assignee && !members.some((person) => person.id === card.assignee!.id)
      ? [...members, card.assignee]
      : members;

  async function save() {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      setError("A card needs a title.");
      return;
    }

    /*
     * Only what actually changed.
     *
     * Sending the whole form makes every save a blind overwrite of the entire
     * row: edit the points after a teammate has renamed the card, and their
     * title goes back to what it said when you opened the drawer. Nothing
     * detects it and nothing can recover it — `card.update` records field
     * *names* only, so both edits log identically and the old value exists
     * nowhere.
     *
     * This is not concurrency control and does not pretend to be. Two people
     * editing the same field still race, and the last writer wins. It removes
     * the case where you clobber a field you never touched, which is the one
     * that happens by accident.
     *
     * It also makes the audit log honest: the payload is `Object.keys(body)`,
     * so a full-form submit reported all five fields as edited every time.
     */
    const patch: Record<string, unknown> = {};
    if (trimmed !== initial.title) patch.title = trimmed;
    if (description !== initial.description) {
      patch.description = description.trim() === "" ? null : description;
    }
    if (priority !== initial.priority) patch.priority = priority;
    if (points !== initial.points) {
      patch.points = points.trim() === "" ? null : Number(points);
    }
    if (assignee !== initial.assignee) {
      patch.assignee_id = assignee === UNASSIGNED_VALUE ? null : assignee;
    }

    // Nothing to send is not an error, and must not become a write: an empty
    // PATCH would still bump `updated_at` and log an edit that did not happen.
    if (Object.keys(patch).length === 0) {
      onCancel();
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/cards/${card.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        /*
         * No column_id, sprint_id or position. PATCH refuses all three by
         * design — moving a card is the move endpoint's job, so ordering has
         * exactly one entry point and one place that generates keys.
         */
        body: JSON.stringify(patch),
      });
      if (!response.ok) throw new Error(`patch_failed_${response.status}`);
      onSaved();
    } catch {
      setError("Could not save those changes.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="card-title">Title</Label>
        <Input
          id="card-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={300}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="card-description">Description</Label>
        <Textarea
          id="card-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Markdown supported"
          rows={6}
        />
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="card-priority">Priority</Label>
          {/* Checked against PRIORITIES rather than cast. The cast compiled and
              would have written null — or any string — into a field the server
              validates as an enum, turning a UI slip into a 400. */}
          <Select
            value={priority}
            onValueChange={(value) => {
              if (PRIORITIES.includes(value as Priority)) {
                setPriority(value as Priority);
              }
            }}
          >
            <SelectTrigger id="card-priority" className="w-32">
              <SelectValue>{(value) => String(value)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {PRIORITIES.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="card-points">Points</Label>
          <Input
            id="card-points"
            type="number"
            min={0}
            max={1000}
            step={1}
            value={points}
            onChange={(event) => setPoints(event.target.value)}
            placeholder="—"
            className="w-24"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="card-assignee">Assignee</Label>
          {/* base-ui can emit null when a select is cleared; fold that onto the
              sentinel rather than letting the state go null, so exactly one
              value means "nobody". */}
          <Select
            value={assignee}
            onValueChange={(value) => setAssignee(value ?? UNASSIGNED_VALUE)}
          >
            <SelectTrigger id="card-assignee" className="w-44">
              <SelectValue>
                {(value) =>
                  value === UNASSIGNED_VALUE
                    ? "Unassigned"
                    : (options.find((person) => person.id === value)?.name ??
                      "Unknown")
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNASSIGNED_VALUE}>Unassigned</SelectItem>
              {options.map((person) => (
                <SelectItem key={person.id} value={person.id}>
                  {person.name ?? "Unnamed"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {error ? <p className="text-destructive text-xs">{error}</p> : null}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
