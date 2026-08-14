"use client";

import { useState } from "react";
import { flushSync } from "react-dom";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
import type { BoardSprint } from "@/types/board";

const ERROR_COPY: Record<string, string> = {
  active_sprint_exists:
    "Another sprint is already active. Complete it before starting this one.",
  sprint_already_completed: "That sprint is already completed.",
  ends_at_before_starts_at: "The end date is before the start date.",
  carry_over_to_self: "A sprint cannot carry cards over to itself.",
};

function describe(error: string | null): string | null {
  if (!error) return null;
  return ERROR_COPY[error] ?? "Something went wrong. Try again.";
}

export function SprintControls({
  workspaceId,
  sprints,
  selected,
  onChanged,
}: {
  workspaceId: number;
  sprints: BoardSprint[];
  selected: BoardSprint | null;
  onChanged: (sprintId?: number) => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [activate, setActivate] = useState(false);
  const [carryOverTo, setCarryOverTo] = useState("backlog");

  const hasActive = sprints.some((sprint) => sprint.status === "active");
  const carryTargets = sprints.filter(
    (sprint) => sprint.status !== "completed" && sprint.id !== selected?.id,
  );

  async function call(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error ?? `request_failed_${response.status}`);
        return null;
      }
      return payload;
    } catch {
      setError("network_error");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function createSprint() {
    // datetime-local has no zone; send it as an explicit UTC instant so the
    // server's z.iso.datetime({ offset: true }) accepts it unambiguously.
    const toInstant = (value: string) =>
      value ? new Date(value).toISOString() : null;

    const result = await call("/api/v1/sprints", {
      workspace_id: workspaceId,
      name: name.trim(),
      goal: goal.trim() || null,
      starts_at: toInstant(startsAt),
      ends_at: toInstant(endsAt),
      activate,
    });
    if (!result) return;
    // Commit the close before navigation starts. `onChanged` calls
    // router.replace, which Next runs inside a transition, and a pending
    // transition defers every other queued update — the dialog would still be
    // on screen when the navigation tears its portal down, leaving `open`
    // stuck at true with nothing rendered. After that the trigger is dead,
    // because clicking it sets true over true and React sees no change.
    flushSync(() => {
      setCreateOpen(false);
      setName("");
      setGoal("");
      setStartsAt("");
      setEndsAt("");
      setActivate(false);
    });
    onChanged(result.sprint?.id);
  }

  async function startSprint() {
    if (!selected) return;
    const result = await call(`/api/v1/sprints/${selected.id}/start`);
    if (result) onChanged(selected.id);
  }

  async function completeSprint() {
    if (!selected) return;
    const result = await call(`/api/v1/sprints/${selected.id}/complete`, {
      carry_over_to:
        carryOverTo === "backlog" ? "backlog" : Number(carryOverTo),
    });
    if (!result) return;
    // Same ordering hazard as createSprint above.
    flushSync(() => setCompleteOpen(false));
    onChanged(selected.id);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogTrigger
          render={
            <Button variant="outline" size="sm">
              New sprint
            </Button>
          }
        />
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New sprint</DialogTitle>
            <DialogDescription>
              Created as planned. Start it when the team is ready.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="sprint-name">Name</Label>
              <Input
                id="sprint-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Sprint 2"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sprint-goal">Goal</Label>
              <Textarea
                id="sprint-goal"
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                placeholder="What does done look like?"
                rows={2}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="sprint-start">Starts</Label>
                <Input
                  id="sprint-start"
                  type="datetime-local"
                  value={startsAt}
                  onChange={(event) => setStartsAt(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sprint-end">Ends</Label>
                <Input
                  id="sprint-end"
                  type="datetime-local"
                  value={endsAt}
                  onChange={(event) => setEndsAt(event.target.value)}
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={activate}
                disabled={hasActive}
                onChange={(event) => setActivate(event.target.checked)}
                className="size-4"
              />
              Start it immediately
              {hasActive ? (
                <span className="text-muted-foreground text-xs">
                  (a sprint is already active)
                </span>
              ) : null}
            </label>
            {error ? (
              <p className="text-destructive text-sm">{describe(error)}</p>
            ) : null}
          </div>

          <DialogFooter>
            <DialogClose
              render={
                <Button variant="outline" size="sm">
                  Cancel
                </Button>
              }
            />
            <Button
              size="sm"
              onClick={createSprint}
              disabled={busy || name.trim().length === 0}
            >
              {busy ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {selected?.status === "planned" ? (
        <Button size="sm" onClick={startSprint} disabled={busy}>
          {busy ? "Starting…" : "Start sprint"}
        </Button>
      ) : null}

      {selected?.status === "active" ? (
        <Dialog open={completeOpen} onOpenChange={setCompleteOpen}>
          <DialogTrigger
            render={
              <Button variant="outline" size="sm">
                Complete sprint
              </Button>
            }
          />
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Complete {selected.name}</DialogTitle>
              <DialogDescription>
                Cards outside the right-most column are unfinished and will be
                carried over. Cards in the right-most column stay with this
                sprint as its record of what shipped.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-2">
              <Label>Carry unfinished cards to</Label>
              <Select value={carryOverTo} onValueChange={(value) => value && setCarryOverTo(value)}>
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {(value) =>
                      String(value) === "backlog"
                        ? "Backlog"
                        : (carryTargets.find(
                            (sprint) => String(sprint.id) === String(value),
                          )?.name ?? "Backlog")
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="backlog">Backlog</SelectItem>
                  {carryTargets.map((sprint) => (
                    <SelectItem key={sprint.id} value={String(sprint.id)}>
                      {sprint.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {error ? (
                <p className="text-destructive text-sm">{describe(error)}</p>
              ) : null}
            </div>

            <DialogFooter>
              <DialogClose
                render={
                  <Button variant="outline" size="sm">
                    Cancel
                  </Button>
                }
              />
              <Button size="sm" onClick={completeSprint} disabled={busy}>
                {busy ? "Completing…" : "Complete"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {error && !createOpen && !completeOpen ? (
        <p className="text-destructive text-sm">{describe(error)}</p>
      ) : null}
    </div>
  );
}
