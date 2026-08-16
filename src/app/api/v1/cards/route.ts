import {
  and,
  asc,
  eq,
  ilike,
  isNotNull,
  isNull,
  or,
  type SQL,
} from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";
import { z } from "zod";

import { db } from "@/db";
import { cards, columns, sprints, users, workspaceMembers } from "@/db/schema";
import { logActivity } from "@/lib/api/activity";
import {
  assigneeJoin,
  cardProjection,
  labelsByCard,
  toApiCard,
} from "@/lib/api/cards";
import {
  parseIntParam,
  resolveActor,
  resolveWorkspace,
} from "@/lib/api/guards";
import { SCOPES } from "@/lib/api/scopes";
import { badRequest, notFound, ok } from "@/lib/api/response";
import { readOrder, type OrderScope } from "@/lib/ordering";

/** Machine clients narrow with filters rather than paging. Bounded either way. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

const createSchema = z.object({
  workspace_id: z.number().int().positive().optional(),
  column_id: z.number().int().positive(),
  sprint_id: z.number().int().positive().nullish(),
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().max(20_000).nullish(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  points: z.number().int().min(0).max(1000).nullish(),
  assignee_id: z.string().trim().min(1).max(255).nullish(),
});

export async function GET(request: Request) {
  const auth = await resolveActor(request, SCOPES.BOARD_READ);
  if (!auth.ok) return auth.response;
  const actor = auth.actor;

  const url = new URL(request.url);
  const workspace = await resolveWorkspace(
    actor,
    parseIntParam(url.searchParams.get("workspace")),
  );
  if (!workspace) return notFound();

  // Every filter is another predicate on a query already constrained to one
  // workspace. None of them can widen the result set.
  const filters: SQL[] = [eq(cards.workspaceId, workspace.id)];

  /*
   * Archived cards are excluded unless asked for.
   *
   * `?archived=true` is the only way back: archiving with no way to list what
   * was archived is deletion with extra steps, and the whole reason this is a
   * timestamp rather than a DELETE is that the row has to remain recoverable.
   */
  const archivedParam = url.searchParams.get("archived");
  if (archivedParam === "true") {
    filters.push(isNotNull(cards.archivedAt));
  } else if (archivedParam === "all") {
    // no predicate
  } else {
    filters.push(isNull(cards.archivedAt));
  }

  const sprintParam = url.searchParams.get("sprint");
  if (sprintParam === "backlog") {
    filters.push(isNull(cards.sprintId));
  } else if (sprintParam) {
    const sprintId = parseIntParam(sprintParam);
    if (!sprintId) return badRequest("invalid_sprint");
    filters.push(eq(cards.sprintId, sprintId));
  }

  const columnParam = url.searchParams.get("column");
  if (columnParam) {
    const columnId = parseIntParam(columnParam);
    if (!columnId) return badRequest("invalid_column");
    filters.push(eq(cards.columnId, columnId));
  }

  const assigneeParam = url.searchParams.get("assignee");
  if (assigneeParam === "unassigned") {
    filters.push(isNull(cards.assigneeId));
  } else if (assigneeParam) {
    filters.push(eq(cards.assigneeId, assigneeParam));
  }

  const q = url.searchParams.get("q")?.trim();
  if (q) {
    // Escape the LIKE metacharacters, so a search for "100%" is a search for a
    // literal "100%" rather than for everything.
    const pattern = `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const match = or(
      ilike(cards.title, pattern),
      ilike(cards.description, pattern),
    );
    if (match) filters.push(match);
  }

  const limit = Math.min(
    parseIntParam(url.searchParams.get("limit")) ?? DEFAULT_LIMIT,
    MAX_LIMIT,
  );

  // One past the limit, purely so the response can admit to being cut short.
  const rows = await db
    .select(cardProjection)
    .from(cards)
    .leftJoin(users, assigneeJoin)
    .where(and(...filters))
    .orderBy(asc(cards.position), asc(cards.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const labelsFor = await labelsByCard(page.map((row) => row.id));

  return ok({
    cards: page.map((row) => toApiCard(row, labelsFor.get(row.id) ?? [])),
    truncated: rows.length > limit,
    limit,
  });
}

export async function POST(request: Request) {
  const auth = await resolveActor(request, SCOPES.BOARD_WRITE);
  if (!auth.ok) return auth.response;
  const actor = auth.actor;

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("invalid_body", parsed.error.issues);

  const workspace = await resolveWorkspace(actor, parsed.data.workspace_id);
  if (!workspace) return notFound();

  const {
    column_id: columnId,
    sprint_id: sprintId,
    title,
    description,
    priority,
    points,
    assignee_id: assigneeId,
  } = parsed.data;

  const [column] = await db
    .select({ id: columns.id })
    .from(columns)
    .where(and(eq(columns.id, columnId), eq(columns.workspaceId, workspace.id)))
    .limit(1);
  if (!column) return notFound();

  const targetSprintId = sprintId ?? null;
  if (targetSprintId !== null) {
    const [sprint] = await db
      .select({ id: sprints.id })
      .from(sprints)
      .where(
        and(
          eq(sprints.id, targetSprintId),
          eq(sprints.workspaceId, workspace.id),
        ),
      )
      .limit(1);
    if (!sprint) return notFound();
  }

  if (assigneeId) {
    // The assignee must be a member of *this* workspace. Without the check a
    // caller could pin a card to any user id in the system, which both reveals
    // whether that id exists and puts a stranger's name on a tenant's board.
    const [member] = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspace.id),
          eq(workspaceMembers.userId, assigneeId),
        ),
      )
      .limit(1);
    if (!member) return notFound();
  }

  const scope: OrderScope =
    targetSprintId === null
      ? { kind: "backlog", workspaceId: workspace.id }
      : {
          kind: "board",
          workspaceId: workspace.id,
          columnId,
          sprintId: targetSprintId,
        };

  const existing = await readOrder(scope);
  const position = generateKeyBetween(existing.at(-1)?.position ?? null, null);

  const [created] = await db
    .insert(cards)
    .values({
      workspaceId: workspace.id,
      columnId,
      sprintId: targetSprintId,
      title,
      description: description ?? null,
      priority: priority ?? "medium",
      points: points ?? null,
      assigneeId: assigneeId ?? null,
      position,
    })
    .returning();

  await logActivity({
    workspaceId: workspace.id,
    cardId: created.id,
    actor,
    action: "card.create",
    payload: {
      title: created.title,
      column_id: columnId,
      sprint_id: targetSprintId,
    },
  });

  return ok({
    // A card created this way has no labels yet — attach them with PATCH.
    card: toApiCard({ ...created, assigneeName: null, assigneeImage: null }, []),
  });
}
