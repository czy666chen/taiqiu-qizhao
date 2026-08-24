import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
};

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    normalizedUsername: text("normalized_username").notNull(),
    displayUsername: text("display_username").notNull(),
    passwordDigest: text("password_digest").notNull(),
    passwordVersion: integer("password_version").notNull().default(1),
    status: text("status", { enum: ["active", "disabled", "deleted"] })
      .notNull()
      .default("active"),
    ...timestamps,
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    uniqueIndex("users_normalized_username_uq").on(table.normalizedUsername),
    check("users_id_uuid_length_ck", sql`length(${table.id}) = 36`),
    check(
      "users_username_format_ck",
      sql`length(${table.normalizedUsername}) between 3 and 8
          and ${table.normalizedUsername} = lower(${table.normalizedUsername})
          and ${table.normalizedUsername} not glob '*[^a-z0-9_]*'`,
    ),
    check("users_password_version_ck", sql`${table.passwordVersion} >= 1`),
    check("users_status_ck", sql`${table.status} in ('active', 'disabled', 'deleted')`),
  ],
);

export const profiles = sqliteTable(
  "profiles",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    publicCode: text("public_code").notNull(),
    nickname: text("nickname").notNull(),
    avatarUrl: text("avatar_url"),
    ...timestamps,
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    uniqueIndex("profiles_public_code_uq").on(table.publicCode),
    check("profiles_public_code_ck", sql`length(${table.publicCode}) between 8 and 32`),
    check("profiles_nickname_ck", sql`length(${table.nickname}) between 1 and 40`),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    tokenDigest: text("token_digest").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    lastUsedAt: integer("last_used_at").notNull().default(sql`(unixepoch() * 1000)`),
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    uniqueIndex("sessions_token_digest_uq").on(table.tokenDigest),
    index("sessions_user_revoked_last_used_idx").on(
      table.userId,
      table.revokedAt,
      table.lastUsedAt,
    ),
    check("sessions_id_uuid_length_ck", sql`length(${table.id}) = 36`),
  ],
);

export const authAuditEvents = sqliteTable(
  "auth_audit_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => users.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    action: text("action").notNull(),
    outcome: text("outcome", { enum: ["success", "failure"] }).notNull(),
    requestId: text("request_id").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("auth_audit_user_created_idx").on(table.userId, table.createdAt),
    index("auth_audit_created_idx").on(table.createdAt),
    check("auth_audit_metadata_json_ck", sql`json_valid(${table.metadataJson})`),
    check("auth_audit_outcome_ck", sql`${table.outcome} in ('success', 'failure')`),
  ],
);

export const playerContacts = sqliteTable(
  "player_contacts",
  {
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    contactUserId: text("contact_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    status: text("status", { enum: ["active", "removed", "blocked"] })
      .notNull()
      .default("active"),
    source: text("source", { enum: ["invite", "match", "manual"] }).notNull(),
    lastPlayedAt: integer("last_played_at"),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.ownerUserId, table.contactUserId] }),
    index("player_contacts_owner_last_played_idx").on(
      table.ownerUserId,
      table.lastPlayedAt,
    ),
    check("player_contacts_not_self_ck", sql`${table.ownerUserId} <> ${table.contactUserId}`),
    check("player_contacts_status_ck", sql`${table.status} in ('active', 'removed', 'blocked')`),
    check("player_contacts_source_ck", sql`${table.source} in ('invite', 'match', 'manual')`),
  ],
);

export const playerInvites = sqliteTable(
  "player_invites",
  {
    id: text("id").primaryKey(),
    creatorUserId: text("creator_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    tokenDigest: text("token_digest").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    usedByUserId: text("used_by_user_id").references(() => users.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    usedAt: integer("used_at"),
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    uniqueIndex("player_invites_token_digest_uq").on(table.tokenDigest),
    index("player_invites_creator_created_idx").on(table.creatorUserId, table.createdAt),
  ],
);

export const scorePresets = sqliteTable(
  "score_presets",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text("name").notNull(),
    rulesJson: text("rules_json").notNull(),
    version: integer("version").notNull().default(1),
    ...timestamps,
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    index("score_presets_owner_deleted_idx").on(table.ownerUserId, table.deletedAt),
    check("score_presets_rules_json_ck", sql`json_valid(${table.rulesJson})`),
    check("score_presets_version_ck", sql`${table.version} >= 1`),
  ],
);

export const decks = sqliteTable(
  "decks",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text("name").notNull(),
    visibility: text("visibility", { enum: ["private", "shared"] })
      .notNull()
      .default("private"),
    currentVersion: integer("current_version").notNull().default(0),
    ...timestamps,
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    index("decks_owner_deleted_idx").on(table.ownerUserId, table.deletedAt),
    check("decks_visibility_ck", sql`${table.visibility} in ('private', 'shared')`),
    check("decks_current_version_ck", sql`${table.currentVersion} >= 0`),
  ],
);

export const customCards = sqliteTable(
  "custom_cards",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    title: text("title").notNull(),
    effect: text("effect").notNull(),
    defaultQuantity: integer("default_quantity").notNull().default(1),
    safetyLevel: text("safety_level", { enum: ["low", "medium", "review"] }).notNull().default("low"),
    safetyNote: text("safety_note"),
    ...timestamps,
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    index("custom_cards_owner_deleted_updated_idx").on(table.ownerUserId, table.deletedAt, table.updatedAt),
    check("custom_cards_quantity_ck", sql`${table.defaultQuantity} between 1 and 10`),
    check("custom_cards_safety_level_ck", sql`${table.safetyLevel} in ('low', 'medium', 'review')`),
  ],
);

export const deckVersions = sqliteTable(
  "deck_versions",
  {
    id: text("id").primaryKey(),
    deckId: text("deck_id")
      .notNull()
      .references(() => decks.id, { onDelete: "cascade", onUpdate: "cascade" }),
    versionNo: integer("version_no").notNull(),
    snapshotJson: text("snapshot_json").notNull(),
    checksum: text("checksum").notNull(),
    operationId: text("operation_id"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("deck_versions_deck_version_uq").on(table.deckId, table.versionNo),
    uniqueIndex("deck_versions_operation_uq").on(table.operationId),
    check("deck_versions_snapshot_json_ck", sql`json_valid(${table.snapshotJson})`),
    check("deck_versions_version_ck", sql`${table.versionNo} >= 1`),
  ],
);

export const deckCards = sqliteTable(
  "deck_cards",
  {
    deckVersionId: text("deck_version_id")
      .notNull()
      .references(() => deckVersions.id, { onDelete: "cascade", onUpdate: "cascade" }),
    cardInstanceId: text("card_instance_id").notNull(),
    cardDefinitionId: text("card_definition_id").notNull(),
    sortOrder: integer("sort_order").notNull(),
    quantity: integer("quantity").notNull().default(1),
    cardSnapshotJson: text("card_snapshot_json").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.deckVersionId, table.cardInstanceId] }),
    uniqueIndex("deck_cards_version_sort_uq").on(table.deckVersionId, table.sortOrder),
    check("deck_cards_quantity_ck", sql`${table.quantity} > 0`),
    check("deck_cards_sort_order_ck", sql`${table.sortOrder} >= 0`),
    check("deck_cards_snapshot_json_ck", sql`json_valid(${table.cardSnapshotJson})`),
  ],
);

export const devices = sqliteTable(
  "devices",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    deviceKey: text("device_key").notNull(),
    name: text("name").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    lastSeenAt: integer("last_seen_at").notNull().default(sql`(unixepoch() * 1000)`),
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    uniqueIndex("devices_user_device_key_uq").on(table.userId, table.deviceKey),
    index("devices_user_revoked_idx").on(table.userId, table.revokedAt),
  ],
);

export const matches = sqliteTable(
  "matches",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
    mode: text("mode").notNull(),
    status: text("status", { enum: ["draft", "active", "completed", "cancelled"] })
      .notNull()
      .default("draft"),
    privacy: text("privacy", { enum: ["private", "participants"] })
      .notNull()
      .default("private"),
    version: integer("version").notNull().default(0),
    writeLeaseDeviceId: text("write_lease_device_id").references(() => devices.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    writeLeaseExpiresAt: integer("write_lease_expires_at"),
    snapshotJson: text("snapshot_json"),
    snapshotChecksum: text("snapshot_checksum"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    startedAt: integer("started_at"),
    endedAt: integer("ended_at"),
  },
  (table) => [
    index("matches_owner_ended_idx").on(table.ownerUserId, table.endedAt),
    index("matches_lease_idx").on(table.writeLeaseDeviceId, table.writeLeaseExpiresAt),
    check("matches_status_ck", sql`${table.status} in ('draft', 'active', 'completed', 'cancelled')`),
    check("matches_privacy_ck", sql`${table.privacy} in ('private', 'participants')`),
    check("matches_version_ck", sql`${table.version} >= 0`),
    check("matches_snapshot_json_ck", sql`${table.snapshotJson} is null or json_valid(${table.snapshotJson})`),
  ],
);

export const matchPlayers = sqliteTable(
  "match_players",
  {
    id: text("id").primaryKey(),
    matchId: text("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade", onUpdate: "cascade" }),
    seatNo: integer("seat_no").notNull(),
    userId: text("user_id").references(() => users.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    role: text("role", { enum: ["host", "player", "spectator"] })
      .notNull()
      .default("player"),
    nicknameSnapshot: text("nickname_snapshot").notNull(),
    joinedAt: integer("joined_at").notNull().default(sql`(unixepoch() * 1000)`),
    leftAt: integer("left_at"),
    kickedAt: integer("kicked_at"),
    kickedByUserId: text("kicked_by_user_id").references(() => users.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
  },
  (table) => [
    uniqueIndex("match_players_match_seat_uq").on(table.matchId, table.seatNo),
    index("match_players_user_match_idx").on(table.userId, table.matchId),
    index("match_players_match_kicked_idx").on(table.matchId, table.kickedAt),
    check("match_players_seat_ck", sql`${table.seatNo} >= 0`),
    check("match_players_role_ck", sql`${table.role} in ('host', 'player', 'spectator')`),
  ],
);

export const realtimeRooms = sqliteTable(
  "realtime_rooms",
  {
    matchId: text("match_id")
      .primaryKey()
      .references(() => matches.id, { onDelete: "cascade", onUpdate: "cascade" }),
    roomCode: text("room_code").notNull(),
    status: text("status", { enum: ["draft", "active", "completed", "archiving_failed"] })
      .notNull()
      .default("draft"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    archivedAt: integer("archived_at"),
  },
  (table) => [
    uniqueIndex("realtime_rooms_code_uq").on(table.roomCode),
    index("realtime_rooms_status_updated_idx").on(table.status, table.updatedAt),
    check(
      "realtime_rooms_status_ck",
      sql`${table.status} in ('draft', 'active', 'completed', 'archiving_failed')`,
    ),
  ],
);

export const scoreEvents = sqliteTable(
  "score_events",
  {
    id: text("id").primaryKey(),
    matchId: text("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade", onUpdate: "cascade" }),
    operationId: text("operation_id").notNull(),
    sequenceNo: integer("sequence_no").notNull(),
    actorUserId: text("actor_user_id").references(() => users.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    actorDeviceId: text("actor_device_id").references(() => devices.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    playerId: text("player_id")
      .notNull()
      .references(() => matchPlayers.id, { onDelete: "cascade", onUpdate: "cascade" }),
    scoreDelta: integer("score_delta").notNull(),
    correctionEventId: text("correction_event_id"),
    payloadJson: text("payload_json").notNull().default("{}"),
    occurredAt: integer("occurred_at").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("score_events_match_sequence_uq").on(table.matchId, table.sequenceNo),
    uniqueIndex("score_events_match_operation_uq").on(table.matchId, table.operationId),
    index("score_events_player_idx").on(table.playerId, table.sequenceNo),
    foreignKey({
      name: "score_events_correction_event_fk",
      columns: [table.correctionEventId],
      foreignColumns: [table.id],
    })
      .onDelete("set null")
      .onUpdate("cascade"),
    check("score_events_sequence_ck", sql`${table.sequenceNo} >= 1`),
    check("score_events_payload_json_ck", sql`json_valid(${table.payloadJson})`),
  ],
);

export const cardEvents = sqliteTable(
  "card_events",
  {
    id: text("id").primaryKey(),
    matchId: text("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade", onUpdate: "cascade" }),
    operationId: text("operation_id").notNull(),
    sequenceNo: integer("sequence_no").notNull(),
    actorUserId: text("actor_user_id").references(() => users.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    actorDeviceId: text("actor_device_id").references(() => devices.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    cardInstanceSnapshotJson: text("card_instance_snapshot_json").notNull(),
    scoreEventId: text("score_event_id").references(() => scoreEvents.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    occurredAt: integer("occurred_at").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("card_events_match_sequence_uq").on(table.matchId, table.sequenceNo),
    uniqueIndex("card_events_match_operation_uq").on(table.matchId, table.operationId),
    check("card_events_sequence_ck", sql`${table.sequenceNo} >= 1`),
    check("card_events_snapshot_json_ck", sql`json_valid(${table.cardInstanceSnapshotJson})`),
  ],
);

export const matchAuditEvents = sqliteTable(
  "match_audit_events",
  {
    id: text("id").primaryKey(),
    matchId: text("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade", onUpdate: "cascade" }),
    actorUserId: text("actor_user_id").references(() => users.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    action: text("action").notNull(),
    reason: text("reason"),
    beforeVersion: integer("before_version"),
    afterVersion: integer("after_version"),
    beforeDigest: text("before_digest"),
    afterDigest: text("after_digest"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("match_audit_match_created_idx").on(table.matchId, table.createdAt),
    index("match_audit_created_idx").on(table.createdAt),
    check("match_audit_metadata_json_ck", sql`json_valid(${table.metadataJson})`),
  ],
);

export const matchClaims = sqliteTable(
  "match_claims",
  {
    id: text("id").primaryKey(),
    matchPlayerId: text("match_player_id")
      .notNull()
      .references(() => matchPlayers.id, { onDelete: "cascade", onUpdate: "cascade" }),
    claimantUserId: text("claimant_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    status: text("status", { enum: ["pending", "approved", "rejected", "cancelled"] })
      .notNull()
      .default("pending"),
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    reviewReason: text("review_reason"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    reviewedAt: integer("reviewed_at"),
    cancelledAt: integer("cancelled_at"),
  },
  (table) => [
    index("match_claims_claimant_status_created_idx").on(
      table.claimantUserId,
      table.status,
      table.createdAt,
    ),
    index("match_claims_player_status_idx").on(table.matchPlayerId, table.status),
    check("match_claims_status_ck", sql`${table.status} in ('pending', 'approved', 'rejected', 'cancelled')`),
  ],
);

export const matchUserStates = sqliteTable(
  "match_user_states",
  {
    // Per-user deletion tombstone. No FK to `matches`: the tombstone must
    // survive the physical deletion of the match row so re-uploads (cross
    // device, offline re-sync) can never resurrect a deleted record.
    matchId: text("match_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    deletedAt: integer("deleted_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    primaryKey({ columns: [table.matchId, table.userId] }),
    index("match_user_states_user_deleted_idx").on(table.userId, table.deletedAt),
    check("match_user_states_deleted_ck", sql`${table.deletedAt} is null or ${table.deletedAt} > 0`),
  ],
);

export const syncReceipts = sqliteTable(
  "sync_receipts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade", onUpdate: "cascade" }),
    operationId: text("operation_id").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    result: text("result", { enum: ["accepted", "duplicate", "rejected", "conflict"] })
      .notNull(),
    responseJson: text("response_json").notNull().default("{}"),
    receivedAt: integer("received_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("sync_receipts_user_operation_uq").on(table.userId, table.operationId),
    index("sync_receipts_user_received_idx").on(table.userId, table.receivedAt),
    index("sync_receipts_received_idx").on(table.receivedAt),
    check("sync_receipts_result_ck", sql`${table.result} in ('accepted', 'duplicate', 'rejected', 'conflict')`),
    check("sync_receipts_response_json_ck", sql`json_valid(${table.responseJson})`),
  ],
);
