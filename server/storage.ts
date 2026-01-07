import {
  conversations,
  messages,
  users,
  readyMessages,
  webhooks,
  webhookEvents,
  appSettings,
  conversationPins,
  userActivity,
  type Conversation,
  type Message,
  type User,
  type Webhook,
  type WebhookEvent,
  type InsertConversation,
  type InsertMessage,
  type InsertUser,
  type ReadyMessage,
  type MessageMedia,
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, sql, and, inArray, aliasedTable } from "drizzle-orm";
import session from "express-session";
import connectPg from "connect-pg-simple";
import { pool } from "./db";

const PostgresSessionStore = connectPg(session);

export type WhatsappInstanceConfig = {
  id: string;
  name: string;
  phoneNumberId: string;
  accessToken: string;
  webhookVerifyToken?: string | null;
  appSecret?: string | null;
  webhookBehavior?: "auto" | "accept" | "reject";
  isActive?: boolean;
  updatedAt?: string;
  source?: "custom" | "env";
};

export type MetaWebhookSettings = {
  path: string;
  updatedAt?: string;
};

export interface IStorage {
  getConversations(page?: number, pageSize?: number, archived?: boolean): Promise<{ items: Conversation[]; total: number }>;
  getConversationByPhone(phone: string): Promise<Conversation | undefined>;
  getConversationById(id: string): Promise<Conversation | undefined>;
  createConversation(conversation: InsertConversation): Promise<Conversation>;
  updateConversationLastAt(id: string): Promise<void>;
  toggleConversationArchive(id: string, archived: boolean): Promise<Conversation>;
  
  getMessages(conversationId: string, page?: number, pageSize?: number): Promise<{ items: Array<Message & { replyTo?: ReplySummary | null; senderName?: string | null }>; total: number }>;
  createMessage(message: InsertMessage): Promise<Message>;
  getMessageById(id: string): Promise<Message | undefined>;
  getMessageWithReplyById(id: string): Promise<(Message & { replyTo?: ReplySummary | null; senderName?: string | null }) | undefined>;
  getMessageByProviderMessageId(providerMessageId: string): Promise<Message | undefined>;
  updateMessageMedia(id: string, media: MessageMedia | null): Promise<Message | undefined>;
  deleteMessage(id: string): Promise<{ id: string; conversationId: string } | null>;
  deleteConversation(id: string): Promise<void>;
  
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  getAllUsers(): Promise<User[]>;
  updateUser(id: string, updates: Partial<Pick<User, "username" | "role" | "password">>): Promise<User>;
  deleteUser(id: string): Promise<void>;

  getReadyMessages(activeOnly?: boolean): Promise<ReadyMessage[]>;
  createReadyMessage(data: {
    name: string;
    body: string;
    createdByUserId?: string | null;
    isActive?: boolean;
  }): Promise<ReadyMessage>;
  updateReadyMessage(
    id: string,
    updates: { name?: string; body?: string; isActive?: boolean },
  ): Promise<ReadyMessage>;
  deleteReadyMessage(id: string): Promise<void>;

  getStatistics(): Promise<any>;
  
  // Webhooks
  createWebhook(data: any): Promise<any>;
  deleteWebhook(id: string): Promise<void>;
  getAllWebhooks(): Promise<any[]>;

  // Webhook events
  logWebhookEvent(event: any): Promise<any>;
  getWebhookEvents(limit?: number, filters?: { webhookId?: string }): Promise<any[]>;

  // App settings
  getDefaultWhatsappInstance(): Promise<WhatsappInstanceConfig | null>;
  setDefaultWhatsappInstance(config: WhatsappInstanceConfig): Promise<void>;
  clearDefaultWhatsappInstance(): Promise<void>;
  getMetaWebhookSettings(): Promise<MetaWebhookSettings>;
  setMetaWebhookSettings(settings: MetaWebhookSettings): Promise<void>;

  getPinnedConversationsForUser(userId: string): Promise<Array<{ conversationId: string; pinnedAt: Date }>>;
  pinConversation(userId: string, conversationId: string): Promise<void>;
  unpinConversation(userId: string, conversationId: string): Promise<void>;
  isConversationPinned(userId: string, conversationId: string): Promise<boolean>;
  countPinnedConversations(userId: string): Promise<number>;
  recordUserActivity(userId: string, now?: Date): Promise<void>;
  
  sessionStore: session.Store;
}

export type ReplySummary = {
  id: string;
  content: string | null;
  direction: "inbound" | "outbound";
  senderLabel: string;
  createdAt: Date;
};

const toSenderLabel = (direction: string): "Customer" | "Agent" => {
  return direction === "inbound" ? "Customer" : "Agent";
};

const ACTIVITY_MAX_IDLE_MS = Number(process.env.ACTIVITY_MAX_IDLE_MS ?? 5 * 60 * 1000);

export class DatabaseStorage implements IStorage {
  sessionStore: session.Store;

  constructor() {
    this.sessionStore = new PostgresSessionStore({ 
      pool, 
      createTableIfMissing: true 
    });
  }

  async getConversations(page: number = 1, pageSize: number = 20, archived: boolean = false): Promise<{ items: Conversation[]; total: number }> {
    const offset = (page - 1) * pageSize;
    
    const [items, totalResult] = await Promise.all([
      db
        .select()
        .from(conversations)
        .where(eq(conversations.archived, archived))
        .orderBy(desc(conversations.lastAt), desc(conversations.createdAt))
        .limit(pageSize)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(conversations)
        .where(eq(conversations.archived, archived)),
    ]);

    return {
      items,
      total: totalResult[0]?.count || 0,
    };
  }

  async getConversationByPhone(phone: string): Promise<Conversation | undefined> {
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.phone, phone));
    return conversation;
  }

  async getConversationById(id: string): Promise<Conversation | undefined> {
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id));
    return conversation;
  }

  async createConversation(insertConversation: InsertConversation): Promise<Conversation> {
    const [conversation] = await db
      .insert(conversations)
      .values(insertConversation)
      .returning();
    return conversation;
  }

  async updateConversationLastAt(id: string): Promise<void> {
    await db
      .update(conversations)
      .set({ lastAt: new Date(), updatedAt: new Date() })
      .where(eq(conversations.id, id));
  }

  async toggleConversationArchive(id: string, archived: boolean): Promise<Conversation> {
    const [conversation] = await db
      .update(conversations)
      .set({ archived, updatedAt: new Date() })
      .where(eq(conversations.id, id))
      .returning();
    return conversation;
  }

  async getMessages(
    conversationId: string,
    page: number = 1,
    pageSize: number = 50
  ): Promise<{ items: Array<Message & { replyTo?: ReplySummary | null; senderName?: string | null }>; total: number }> {
    const offset = (page - 1) * pageSize;
    const [itemsRaw, totalRaw] = await Promise.all([
      db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(messages.createdAt)
        .limit(pageSize)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(messages)
        .where(eq(messages.conversationId, conversationId)),
    ]);

    const items = itemsRaw as Message[];
    const totalResult = totalRaw as Array<{ count: number }>;

    const replyIds = items
      .map((message) => message.replyToMessageId)
      .filter((value): value is string => Boolean(value));

    const replyMap = new Map<string, ReplySummary>();
    let replyMessages: Array<{
      id: string;
      content: string | null;
      direction: string;
      createdAt: Date;
      sentByUserId: string | null;
    }> = [];

    if (replyIds.length > 0) {
      replyMessages = (await db
        .select({
          id: messages.id,
          content: messages.body,
          direction: messages.direction,
          createdAt: messages.createdAt,
          sentByUserId: messages.sentByUserId,
        })
        .from(messages)
        .where(inArray(messages.id, replyIds))
        .execute()) as Array<{
        id: string;
        content: string | null;
        direction: string;
        createdAt: Date;
        sentByUserId: string | null;
      }>;
    }

    const senderIds = new Set<string>();
    items.forEach((message) => {
      if (message.sentByUserId) {
        senderIds.add(message.sentByUserId);
      }
    });
    replyMessages.forEach((reply) => {
      if (reply.sentByUserId) {
        senderIds.add(reply.sentByUserId);
      }
    });

    const senderMap = new Map<string, string>();
    if (senderIds.size > 0) {
      const senderRows = await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(inArray(users.id, Array.from(senderIds)));
      senderRows.forEach((row) => senderMap.set(row.id, row.username));
    }

    replyMessages.forEach((reply) => {
      const normalizedDirection = reply.direction === "outbound" ? "outbound" : "inbound";
      const senderName = reply.sentByUserId ? senderMap.get(reply.sentByUserId) ?? null : null;
      replyMap.set(reply.id, {
        id: reply.id,
        content: reply.content,
        direction: normalizedDirection,
        senderLabel: senderName ?? toSenderLabel(normalizedDirection),
        createdAt: reply.createdAt,
      });
    });

    const itemsWithReplies: Array<Message & { replyTo?: ReplySummary | null; senderName?: string | null }> = items.map(
      (message) => {
        const normalizedDirection = message.direction === "outbound" ? "outbound" : "inbound";
        const senderName = message.sentByUserId ? senderMap.get(message.sentByUserId) ?? null : null;
        return {
          ...message,
          direction: normalizedDirection,
          senderName,
          replyTo: message.replyToMessageId ? replyMap.get(message.replyToMessageId) ?? null : null,
        };
      },
    );

    return {
      items: itemsWithReplies,
      total: totalResult[0]?.count || 0,
    };
  }

  async createMessage(insertMessage: InsertMessage): Promise<Message> {
    const [message] = await db
      .insert(messages)
      .values(insertMessage as any)
      .returning();
    return message;
  }

  async getMessageById(id: string): Promise<Message | undefined> {
    const [message] = (await db.select().from(messages).where(eq(messages.id, id))) as Message[];
    return message;
  }

  async getMessageByProviderMessageId(providerMessageId: string): Promise<Message | undefined> {
    const [message] = (await db
      .select()
      .from(messages)
      .where(eq(messages.providerMessageId, providerMessageId))
      .limit(1)) as Message[];
    return message;
  }

  async updateMessageMedia(id: string, media: MessageMedia | null): Promise<Message | undefined> {
    const [updated] = (await db
      .update(messages)
      .set({ media })
      .where(eq(messages.id, id))
      .returning()) as Message[];
    return updated;
  }

  async getMessageWithReplyById(id: string): Promise<(Message & { replyTo?: ReplySummary | null; senderName?: string | null }) | undefined> {
    const message = await this.getMessageById(id);
    if (!message) return undefined;

    const normalizedMessageDirection = message.direction === "outbound" ? "outbound" : "inbound";
    const senderIds = new Set<string>();
    if (message.sentByUserId) {
      senderIds.add(message.sentByUserId);
    }

    if (!message.replyToMessageId) {
      let senderName: string | null = null;
      if (message.sentByUserId) {
        const [sender] = await db
          .select({ username: users.username })
          .from(users)
          .where(eq(users.id, message.sentByUserId))
          .limit(1);
        senderName = sender?.username ?? null;
      }
      return { ...message, direction: normalizedMessageDirection, senderName, replyTo: null };
    }

    const [reply] = (await db
      .select({
        id: messages.id,
        content: messages.body,
        direction: messages.direction,
        createdAt: messages.createdAt,
        sentByUserId: messages.sentByUserId,
      })
      .from(messages)
      .where(eq(messages.id, message.replyToMessageId))) as Array<{
        id: string;
        content: string | null;
        direction: string;
        createdAt: Date;
        sentByUserId: string | null;
      }>;

    if (reply?.sentByUserId) {
      senderIds.add(reply.sentByUserId);
    }

    const senderMap = new Map<string, string>();
    if (senderIds.size > 0) {
      const senderRows = await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(inArray(users.id, Array.from(senderIds)));
      senderRows.forEach((row) => senderMap.set(row.id, row.username));
    }

    const senderName = message.sentByUserId ? senderMap.get(message.sentByUserId) ?? null : null;

    if (!reply) {
      return { ...message, direction: normalizedMessageDirection, senderName, replyTo: null };
    }

    const normalizedReplyDirection = reply.direction === "outbound" ? "outbound" : "inbound";
    const replySenderName = reply.sentByUserId ? senderMap.get(reply.sentByUserId) ?? null : null;

    return {
      ...message,
      direction: normalizedMessageDirection,
      senderName,
      replyTo: {
        id: reply.id,
        content: reply.content,
        direction: normalizedReplyDirection,
        senderLabel: replySenderName ?? toSenderLabel(normalizedReplyDirection),
        createdAt: reply.createdAt,
      },
    } as Message & { replyTo?: ReplySummary | null };
  }

  async deleteMessage(id: string): Promise<{ id: string; conversationId: string } | null> {
    const [deleted] = await db
      .delete(messages)
      .where(eq(messages.id, id))
      .returning({ id: messages.id, conversationId: messages.conversationId });

    return deleted ?? null;
  }

  async deleteConversation(id: string): Promise<void> {
    await db.delete(conversations).where(eq(conversations.id, id));
  }

  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.username, username));
    return user;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(insertUser)
      .returning();
    return user;
  }

  async getAllUsers(): Promise<User[]> {
    return await db
      .select()
      .from(users)
      .orderBy(users.createdAt);
  }

  async updateUser(id: string, updates: Partial<Pick<User, "username" | "role" | "password">>): Promise<User> {
    const [user] = await db
      .update(users)
      .set(updates)
      .where(eq(users.id, id))
      .returning();
    return user;
  }

  async deleteUser(id: string): Promise<void> {
    await db
      .delete(users)
      .where(eq(users.id, id));
  }

  async getReadyMessages(activeOnly: boolean = true): Promise<ReadyMessage[]> {
    let query = db.select().from(readyMessages) as any;
    if (activeOnly) {
      query = query.where(eq(readyMessages.isActive, true));
    }
    return await query.orderBy(desc(readyMessages.updatedAt), desc(readyMessages.createdAt));
  }

  async createReadyMessage(data: {
    name: string;
    body: string;
    createdByUserId?: string | null;
    isActive?: boolean;
  }): Promise<ReadyMessage> {
    const [message] = await db
      .insert(readyMessages)
      .values({
        name: data.name,
        body: data.body,
        createdByUserId: data.createdByUserId ?? null,
        isActive: data.isActive ?? true,
        updatedAt: new Date(),
      })
      .returning();
    return message;
  }

  async updateReadyMessage(
    id: string,
    updates: { name?: string; body?: string; isActive?: boolean },
  ): Promise<ReadyMessage> {
    const [message] = await db
      .update(readyMessages)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(readyMessages.id, id))
      .returning();
    return message;
  }

  async deleteReadyMessage(id: string): Promise<void> {
    await db.delete(readyMessages).where(eq(readyMessages.id, id));
  }

  async recordUserActivity(userId: string, now: Date = new Date()): Promise<void> {
    const dayKey = now.toISOString().slice(0, 10);
    const [existing] = await db
      .select({
        activeSeconds: userActivity.activeSeconds,
        lastSeenAt: userActivity.lastSeenAt,
      })
      .from(userActivity)
      .where(and(eq(userActivity.userId, userId), eq(userActivity.day, dayKey)))
      .limit(1);

    if (!existing) {
      await db.insert(userActivity).values({
        userId,
        day: dayKey,
        activeSeconds: 0,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      });
      return;
    }

    let incrementSeconds = 0;
    if (existing.lastSeenAt) {
      const lastSeenAt = new Date(existing.lastSeenAt);
      const deltaMs = now.getTime() - lastSeenAt.getTime();
      if (deltaMs > 0 && deltaMs <= ACTIVITY_MAX_IDLE_MS) {
        incrementSeconds = Math.floor(deltaMs / 1000);
      }
    }

    await db
      .update(userActivity)
      .set({
        activeSeconds: existing.activeSeconds + incrementSeconds,
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(and(eq(userActivity.userId, userId), eq(userActivity.day, dayKey)));
  }

  async getStatistics(): Promise<any> {
    // Get total counts
    const [totalConversations] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(conversations);

    const [totalMessages] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages);

    const [incomingCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(eq(messages.direction, "inbound"));

    const [outgoingCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(eq(messages.direction, "outbound"));

    // Get most active conversations (top 5)
    const topConversations = await db
      .select({
        phone: conversations.phone,
        displayName: conversations.displayName,
        messageCount: sql<number>`count(${messages.id})::int`,
      })
      .from(conversations)
      .leftJoin(messages, eq(messages.conversationId, conversations.id))
      .groupBy(conversations.id, conversations.phone, conversations.displayName)
      .orderBy(desc(sql`count(${messages.id})`))
      .limit(5);

    // Get messages by day (last 7 days)
    const messagesByDay = await db
      .select({
        date: sql<string>`DATE(${messages.createdAt})`,
        incoming: sql<number>`count(CASE WHEN ${messages.direction} = 'inbound' THEN 1 END)::int`,
        outgoing: sql<number>`count(CASE WHEN ${messages.direction} = 'outbound' THEN 1 END)::int`,
      })
      .from(messages)
      .where(sql`${messages.createdAt} >= NOW() - INTERVAL '7 days'`)
      .groupBy(sql`DATE(${messages.createdAt})`)
      .orderBy(sql`DATE(${messages.createdAt})`);

    // Get recent activity (last 10 messages)
    const recentActivity = await db
      .select({
        id: messages.id,
        direction: messages.direction,
        body: messages.body,
        createdAt: messages.createdAt,
        phone: conversations.phone,
        displayName: conversations.displayName,
      })
      .from(messages)
      .leftJoin(conversations, eq(messages.conversationId, conversations.id))
      .orderBy(desc(messages.createdAt))
      .limit(10);

    // User-level statistics
    const usersList = await db
      .select({
        id: users.id,
        username: users.username,
        role: users.role,
        createdAt: users.createdAt,
      })
      .from(users);

    const messagesByUser = await db
      .select({
        userId: messages.sentByUserId,
        totalMessages: sql<number>`count(${messages.id})::int`,
        mediaMessages: sql<number>`count(CASE WHEN ${messages.media} IS NOT NULL THEN 1 END)::int`,
        repliesSent: sql<number>`count(CASE WHEN ${messages.replyToMessageId} IS NOT NULL THEN 1 END)::int`,
        templatesSent: sql<number>`count(CASE WHEN (${messages.raw} -> 'template') IS NOT NULL OR ${messages.body} ILIKE 'Template:%' THEN 1 END)::int`,
        conversationsTouched: sql<number>`count(DISTINCT ${messages.conversationId})::int`,
        lastSentAt: sql<string | null>`max(${messages.createdAt})`,
      })
      .from(messages)
      .where(sql`${messages.sentByUserId} IS NOT NULL`)
      .groupBy(messages.sentByUserId);

    const conversationsByUser = await db
      .select({
        userId: conversations.createdByUserId,
        totalConversations: sql<number>`count(${conversations.id})::int`,
        lastCreatedAt: sql<string | null>`max(${conversations.createdAt})`,
      })
      .from(conversations)
      .where(sql`${conversations.createdByUserId} IS NOT NULL`)
      .groupBy(conversations.createdByUserId);

    const replyTarget = aliasedTable(messages, "reply_target");
    const responseTimesByUser = await db
      .select({
        userId: messages.sentByUserId,
        avgResponseSeconds: sql<number | null>`avg(extract(epoch from (${messages.createdAt} - ${replyTarget.createdAt})))`,
        responseCount: sql<number>`count(${messages.id})::int`,
      })
      .from(messages)
      .innerJoin(replyTarget, eq(messages.replyToMessageId, replyTarget.id))
      .where(
        and(
          sql`${messages.sentByUserId} IS NOT NULL`,
          eq(messages.direction, "outbound"),
          eq(replyTarget.direction, "inbound"),
        ),
      )
      .groupBy(messages.sentByUserId);

    const activityByUser = await db
      .select({
        userId: userActivity.userId,
        activeSeconds: sql<number>`sum(${userActivity.activeSeconds})::int`,
      })
      .from(userActivity)
      .where(sql`${userActivity.day} >= CURRENT_DATE - 6`)
      .groupBy(userActivity.userId);

    const toDate = (value: unknown): Date | null => {
      if (!value) return null;
      if (value instanceof Date) {
        return value;
      }
      const date = new Date(String(value));
      return Number.isNaN(date.getTime()) ? null : date;
    };

    const messageStatsMap = new Map<
      string,
      {
        totalMessages: number;
        mediaMessages: number;
        repliesSent: number;
        templatesSent: number;
        conversationsTouched: number;
        lastSentAt: Date | null;
      }
    >();
    for (const stat of messagesByUser) {
      if (!stat.userId) continue;
      messageStatsMap.set(stat.userId, {
        totalMessages: stat.totalMessages,
        mediaMessages: stat.mediaMessages,
        repliesSent: stat.repliesSent,
        templatesSent: stat.templatesSent,
        conversationsTouched: stat.conversationsTouched,
        lastSentAt: toDate(stat.lastSentAt),
      });
    }

    const responseTimeMap = new Map<
      string,
      {
        avgResponseSeconds: number | null;
        responseCount: number;
      }
    >();
    for (const stat of responseTimesByUser) {
      if (!stat.userId) continue;
      responseTimeMap.set(stat.userId, {
        avgResponseSeconds: stat.avgResponseSeconds ? Number(stat.avgResponseSeconds) : null,
        responseCount: stat.responseCount,
      });
    }

    const activityTimeMap = new Map<string, number>();
    for (const stat of activityByUser) {
      if (!stat.userId) continue;
      activityTimeMap.set(stat.userId, stat.activeSeconds ?? 0);
    }

    const conversationStatsMap = new Map<
      string,
      {
        totalConversations: number;
        lastCreatedAt: Date | null;
      }
    >();
    for (const stat of conversationsByUser) {
      if (!stat.userId) continue;
      conversationStatsMap.set(stat.userId, {
        totalConversations: stat.totalConversations,
        lastCreatedAt: toDate(stat.lastCreatedAt),
      });
    }

    const totalOutgoingMessages = outgoingCount?.count || 0;

    const userStats = usersList.map((user) => {
      const messageInfo = messageStatsMap.get(user.id);
      const conversationInfo = conversationStatsMap.get(user.id);
      const responseInfo = responseTimeMap.get(user.id);
      const activeSeconds = activityTimeMap.get(user.id) ?? 0;

      const messagesSent = messageInfo?.totalMessages ?? 0;
      const mediaSent = messageInfo?.mediaMessages ?? 0;
      const repliesSent = messageInfo?.repliesSent ?? 0;
      const templatesSent = messageInfo?.templatesSent ?? 0;
      const newMessagesSent = Math.max(messagesSent - repliesSent, 0);
      const conversationsCreated = conversationInfo?.totalConversations ?? 0;
      const contactsEngaged = messageInfo?.conversationsTouched ?? 0;
      const avgResponseSeconds = responseInfo?.avgResponseSeconds ?? null;
      const responseCount = responseInfo?.responseCount ?? 0;

      const candidateDates = [
        messageInfo?.lastSentAt ?? null,
        conversationInfo?.lastCreatedAt ?? null,
      ].filter((value): value is Date => value instanceof Date);

      const lastActive =
        candidateDates.length > 0
          ? new Date(Math.max(...candidateDates.map((date) => date.getTime())))
          : null;

      const engagementRate =
        totalOutgoingMessages > 0
          ? Math.round((messagesSent / totalOutgoingMessages) * 1000) / 10
          : 0;

      const activityScore = messagesSent + conversationsCreated;

      return {
        id: user.id,
        username: user.username,
        role: user.role,
        createdAt: user.createdAt,
        messagesSent,
        mediaSent,
        repliesSent,
        newMessagesSent,
        templatesSent,
        conversationsCreated,
        contactsEngaged,
        avgResponseSeconds,
        responseCount,
        activeSeconds,
        lastActiveAt: lastActive ? lastActive.toISOString() : null,
        engagementRate,
        activityScore,
      };
    }).sort((a, b) => {
      if (b.activityScore !== a.activityScore) {
        return b.activityScore - a.activityScore;
      }
      return b.messagesSent - a.messagesSent;
    });

    return {
      totals: {
        conversations: totalConversations?.count || 0,
        messages: totalMessages?.count || 0,
        incoming: incomingCount?.count || 0,
        outgoing: outgoingCount?.count || 0,
        users: usersList.length,
      },
      topConversations,
      messagesByDay,
      recentActivity,
      userStats,
    };
  }


  // Webhooks
  async createWebhook(data: any): Promise<any> {
    const [hook] = await db
      .insert(webhooks)
      .values({
        name: data.name,
        url: data.url,
        verifyToken: data.verifyToken || null,
        isActive: data.isActive ?? true,
        updatedAt: new Date(),
      })
      .returning();
    return hook;
  }

  async deleteWebhook(id: string): Promise<void> {
    await db
      .delete(webhooks)
      .where(eq(webhooks.id, id));
  }

  async getAllWebhooks(): Promise<any[]> {
    return await db.select().from(webhooks).orderBy(desc(webhooks.createdAt));
  }

  async updateWebhook(id: string, updates: Partial<{ name: string; url: string; verifyToken: string | null; isActive: boolean }>): Promise<any> {
    const [hook] = await db
      .update(webhooks)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(webhooks.id, id))
      .returning();
    return hook;
  }

  // Webhook events
  async logWebhookEvent(event: any): Promise<any> {
    const [row] = await db
      .insert(webhookEvents)
      .values({
        webhookId: event.webhookId || null,
        headers: event.headers || {},
        query: event.query || {},
        body: event.body || null,
        response: event.response || null,
      })
      .returning();
    return row;
  }

  async getWebhookEvents(limit: number = 200, filters?: { webhookId?: string }): Promise<any[]> {
    let query = db.select().from(webhookEvents) as any;

    if (filters?.webhookId) {
      query = query.where(eq(webhookEvents.webhookId, filters.webhookId));
    }

    return await query.orderBy(desc(webhookEvents.createdAt)).limit(limit);
  }

  async deleteWebhookEvents(): Promise<void> {
    await db.delete(webhookEvents);
  }

  async deleteWebhookEventById(id: string): Promise<void> {
    await db.delete(webhookEvents).where(eq(webhookEvents.id, id));
  }

  // Admin: update basic entities safely (users, instances, webhooks)
  async adminUpdateUser(id: string, updates: Partial<{ username: string; role: string }>) {
    const [user] = await db.update(users).set({ ...updates }).where(eq(users.id, id)).returning();
    return user;
  }


  async adminUpdateWebhook(id: string, updates: Partial<{ name: string; url: string; verifyToken?: string | null; isActive?: boolean }>) {
    const [hook] = await db.update(webhooks).set({ ...updates, updatedAt: new Date() }).where(eq(webhooks.id, id)).returning();
    return hook;
  }

  async getDefaultWhatsappInstance(): Promise<WhatsappInstanceConfig | null> {
    const stored = await this.getAppSetting("defaultWhatsappInstance");
    if (stored) {
      return {
        id: stored.id || "default",
        name: stored.name || "Default WhatsApp Instance",
        phoneNumberId: stored.phoneNumberId || "",
        accessToken: stored.accessToken || "",
        webhookVerifyToken: stored.webhookVerifyToken ?? null,
        appSecret: stored.appSecret ?? null,
        webhookBehavior: stored.webhookBehavior || "auto",
        isActive: typeof stored.isActive === "boolean" ? stored.isActive : true,
        updatedAt: stored.updatedAt,
        source: "custom",
      };
    }

    if (process.env.META_TOKEN || process.env.META_PHONE_NUMBER_ID) {
      return {
        id: "default",
        name: "Default WhatsApp Instance",
        phoneNumberId: process.env.META_PHONE_NUMBER_ID || "",
        accessToken: process.env.META_TOKEN || "",
        webhookVerifyToken: process.env.META_VERIFY_TOKEN || null,
        appSecret: process.env.META_APP_SECRET || null,
        webhookBehavior: "auto",
        isActive: true,
        source: "env",
      };
    }

    return null;
  }

  async setDefaultWhatsappInstance(config: WhatsappInstanceConfig): Promise<void> {
    const payload: WhatsappInstanceConfig = {
      ...config,
      id: "default",
      name: config.name || "Default WhatsApp Instance",
      phoneNumberId: config.phoneNumberId,
      accessToken: config.accessToken,
      webhookVerifyToken: config.webhookVerifyToken ?? null,
      appSecret: config.appSecret ?? null,
      webhookBehavior: config.webhookBehavior || "auto",
      isActive: typeof config.isActive === "boolean" ? config.isActive : true,
      updatedAt: new Date().toISOString(),
      source: "custom",
    };

    await this.setAppSetting("defaultWhatsappInstance", payload);
  }

  async clearDefaultWhatsappInstance(): Promise<void> {
    await db.delete(appSettings).where(eq(appSettings.key, "defaultWhatsappInstance"));
  }

  async getPinnedConversationsForUser(
    userId: string,
  ): Promise<Array<{ conversationId: string; pinnedAt: Date }>> {
    const rows = await db
      .select({
        conversationId: conversationPins.conversationId,
        pinnedAt: conversationPins.pinnedAt,
      })
      .from(conversationPins)
      .where(eq(conversationPins.userId, userId))
      .orderBy(desc(conversationPins.pinnedAt));

    return rows.map((row) => ({
      conversationId: row.conversationId,
      pinnedAt: row.pinnedAt ?? new Date(0),
    }));
  }

  async pinConversation(userId: string, conversationId: string): Promise<void> {
    await db
      .insert(conversationPins)
      .values({ userId, conversationId })
      .onConflictDoUpdate({
        target: [conversationPins.userId, conversationPins.conversationId],
        set: {
          pinnedAt: new Date(),
        },
      });
  }

  async unpinConversation(userId: string, conversationId: string): Promise<void> {
    await db
      .delete(conversationPins)
      .where(
        and(
          eq(conversationPins.userId, userId),
          eq(conversationPins.conversationId, conversationId),
        ),
      );
  }

  async isConversationPinned(userId: string, conversationId: string): Promise<boolean> {
    const result = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(conversationPins)
      .where(
        and(
          eq(conversationPins.userId, userId),
          eq(conversationPins.conversationId, conversationId),
        ),
      )
      .limit(1);

    return (result[0]?.count ?? 0) > 0;
  }

  async countPinnedConversations(userId: string): Promise<number> {
    const result = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(conversationPins)
      .where(eq(conversationPins.userId, userId))
      .limit(1);

    return result[0]?.count ?? 0;
  }

  private sanitizeWebhookPath(path: unknown): string {
    const fallback = "/webhook/meta";
    if (typeof path !== "string" || path.trim().length === 0) {
      return fallback;
    }

    let normalized = path.trim();

    if (!normalized.startsWith("/")) {
      normalized = `/${normalized}`;
    }

    normalized = normalized.replace(/\/{2,}/g, "/");

    if (normalized.length > 1 && normalized.endsWith("/")) {
      normalized = normalized.replace(/\/+$/, "");
    }

    if (!normalized.startsWith("/webhook")) {
      normalized = `/webhook${normalized === "/" ? "" : normalized}`;
    }

    return normalized || fallback;
  }

  private defaultMetaWebhookSettings(): MetaWebhookSettings {
    return {
      path: "/webhook/meta",
      updatedAt: new Date().toISOString(),
    };
  }

  async getMetaWebhookSettings(): Promise<MetaWebhookSettings> {
    const stored = await this.getAppSetting("metaWebhookSettings");
    const defaults = this.defaultMetaWebhookSettings();

    if (!stored || typeof stored.path !== "string") {
      return defaults;
    }

    return {
      path: this.sanitizeWebhookPath(stored.path),
      updatedAt: stored.updatedAt || defaults.updatedAt,
    };
  }

  async setMetaWebhookSettings(settings: MetaWebhookSettings): Promise<void> {
    const payload: MetaWebhookSettings = {
      path: this.sanitizeWebhookPath(settings.path),
      updatedAt: new Date().toISOString(),
    };

    await this.setAppSetting("metaWebhookSettings", payload);
  }

  // App settings (simple key/value JSON store)
  async getAppSetting(key: string): Promise<any | null> {
    const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key));
    return row ? row.value : null;
  }

  async setAppSetting(key: string, value: any): Promise<void> {
    const existing = await db.select().from(appSettings).where(eq(appSettings.key, key));
    if (existing.length > 0) {
      await db.update(appSettings).set({ value, updatedAt: new Date() }).where(eq(appSettings.key, key));
    } else {
      await db.insert(appSettings).values({ key, value, updatedAt: new Date() });
    }
  }

}

export const storage = new DatabaseStorage();
