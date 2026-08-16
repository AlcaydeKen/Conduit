import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { AdapterAccountType } from "next-auth/adapters";

/* -------------------------------------------------------------------------- */
/* Enums                                                                      */
/* -------------------------------------------------------------------------- */

export const memberRoleEnum = pgEnum("member_role", ["owner", "member"]);

export const sprintStatusEnum = pgEnum("sprint_status", [
  "planned",
  "active",
  "completed",
]);

export const cardPriorityEnum = pgEnum("card_priority", [
  "low",
  "medium",
  "high",
  "urgent",
]);

export const aiJobKindEnum = pgEnum("ai_job_kind", [
  "draft_card",
  "suggest_labels",
  "estimate_points",
  "split_epic",
  "standup_digest",
  "retro_summary",
]);

export const aiJobStatusEnum = pgEnum("ai_job_status", [
  "pending",
  "claimed",
  "done",
  "failed",
]);

/* -------------------------------------------------------------------------- */
/* Auth.js tables                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Shape is dictated by @auth/drizzle-adapter. `image` doubles as the avatar
 * column referenced by the spec.
 */
export const users = pgTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").notNull().unique(),
  emailVerified: timestamp("email_verified", { withTimezone: true }),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const accounts = pgTable(
  "accounts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.providerAccountId] }),
  ],
);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.identifier, table.token] })],
);

/* -------------------------------------------------------------------------- */
/* Tenancy                                                                    */
/* -------------------------------------------------------------------------- */

export const workspaces = pgTable("workspaces", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdBy: text("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRoleEnum("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index("workspace_members_user_idx").on(table.userId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Board                                                                      */
/* -------------------------------------------------------------------------- */

export const sprints = pgTable(
  "sprints",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    goal: text("goal"),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    status: sprintStatusEnum("status").notNull().default("planned"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("sprints_workspace_idx").on(table.workspaceId)],
);

/**
 * Board columns. `position` is a plain integer here — columns are reordered by
 * a human a handful of times, so fractional indexing buys nothing.
 */
export const columns = pgTable(
  "columns",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    wipLimit: integer("wip_limit"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("columns_workspace_idx").on(table.workspaceId)],
);

export const cards = pgTable(
  "cards",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** null = backlog */
    sprintId: integer("sprint_id").references(() => sprints.id, {
      onDelete: "set null",
    }),
    columnId: integer("column_id")
      .notNull()
      .references(() => columns.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    description: text("description"),
    assigneeId: text("assignee_id").references(() => users.id, {
      onDelete: "set null",
    }),
    priority: cardPriorityEnum("priority").notNull().default("medium"),
    points: integer("points"),
    /** fractional index, always computed server-side */
    position: text("position").notNull(),
    /**
     * Set = archived, hidden from every board read. Null = live.
     *
     * Archived rather than deleted because `comments`, `activity` and `ai_jobs`
     * all reference cards and `activity` cascades — a hard delete would erase
     * the audit trail this system is built around, in order to tidy a board.
     */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Serves the ordered board read: ORDER BY position ASC, id ASC
    index("cards_board_idx").on(
      table.workspaceId,
      table.columnId,
      table.position,
      table.id,
    ),
    // Every board read now carries `archived_at IS NULL`, and on a board where
    // most cards are eventually archived that predicate is the selective one.
    index("cards_live_idx")
      .on(table.workspaceId, table.columnId, table.position, table.id)
      .where(sql`archived_at is null`),
    index("cards_sprint_idx").on(table.workspaceId, table.sprintId),
    index("cards_assignee_idx").on(table.workspaceId, table.assigneeId),
  ],
);

export const comments = pgTable(
  "comments",
  {
    id: serial("id").primaryKey(),
    cardId: integer("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    authorId: text("author_id").references(() => users.id, {
      onDelete: "set null",
    }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("comments_card_idx").on(table.cardId, table.createdAt)],
);

export const labels = pgTable(
  "labels",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("#64748b"),
  },
  (table) => [
    uniqueIndex("labels_workspace_name_idx").on(table.workspaceId, table.name),
  ],
);

export const cardLabels = pgTable(
  "card_labels",
  {
    cardId: integer("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    labelId: integer("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.cardId, table.labelId] }),
    index("card_labels_label_idx").on(table.labelId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Audit + machine access                                                     */
/* -------------------------------------------------------------------------- */

export const activity = pgTable(
  "activity",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    cardId: integer("card_id").references(() => cards.id, {
      onDelete: "cascade",
    }),
    /** user id, or the label of the API key that acted */
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("activity_workspace_idx").on(table.workspaceId, table.createdAt),
    index("activity_card_idx").on(table.cardId),
  ],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: serial("id").primaryKey(),
    /** null = service-scoped claim key (see SPEC "Queue auth") */
    workspaceId: integer("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    label: text("label").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revoked: boolean("revoked").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("api_keys_workspace_idx").on(table.workspaceId)],
);

/**
 * The queue n8n drains. `workspace_id` lives on the row on purpose: the result
 * callback must never resolve the tenant by joining through `card_id`.
 */
export const aiJobs = pgTable(
  "ai_jobs",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    cardId: integer("card_id").references(() => cards.id, {
      onDelete: "cascade",
    }),
    kind: aiJobKindEnum("kind").notNull(),
    status: aiJobStatusEnum("status").notNull().default("pending"),
    input: jsonb("input"),
    result: jsonb("result"),
    error: text("error"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Serves the claim scan: pending jobs, oldest first
    index("ai_jobs_claim_idx").on(table.status, table.createdAt),
    index("ai_jobs_workspace_idx").on(table.workspaceId),
    index("ai_jobs_card_idx").on(table.cardId),
    /**
     * At most one unfinished job per card and kind, enforced by the database
     * rather than by a check in the route.
     *
     * A select-then-insert cannot do this: two clicks that overlap both see an
     * empty result and both insert. Partial, so completed and failed jobs
     * accumulate freely — the constraint is on what is *outstanding*, not on
     * the card's history.
     */
    uniqueIndex("ai_jobs_one_open_per_card_kind_idx")
      .on(table.cardId, table.kind)
      .where(sql`status in ('pending', 'claimed')`),
  ],
);

/* -------------------------------------------------------------------------- */
/* Inferred types                                                             */
/* -------------------------------------------------------------------------- */

export type User = typeof users.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type Sprint = typeof sprints.$inferSelect;
export type BoardColumn = typeof columns.$inferSelect;
export type Card = typeof cards.$inferSelect;
export type Comment = typeof comments.$inferSelect;
export type Label = typeof labels.$inferSelect;
export type Activity = typeof activity.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type AiJob = typeof aiJobs.$inferSelect;
