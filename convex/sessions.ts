import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Sync sessions from Gateway → Convex
export const syncFromGateway = mutation({
  args: {
    instanceId: v.string(),
    sessions: v.array(
      v.object({
        sessionKey: v.string(),
        title: v.string(),
        isPinned: v.boolean(),
        lastMessagePreview: v.string(),
        updatedAt: v.number(),
        createdAt: v.number(),
      })
    ),
  },
  handler: async (ctx, { instanceId, sessions }) => {
    for (const session of sessions) {
      const existing = await ctx.db
        .query("sessions")
        .withIndex("by_instanceId_sessionKey", (q) =>
          q.eq("instanceId", instanceId).eq("sessionKey", session.sessionKey)
        )
        .first();

      if (existing) {
        await ctx.db.patch(existing._id, {
          title: session.title,
          isPinned: session.isPinned,
          lastMessagePreview: session.lastMessagePreview,
          updatedAt: session.updatedAt,
        });
      } else {
        await ctx.db.insert("sessions", {
          instanceId,
          ...session,
        });
      }
    }
  },
});

// Get sessions for an instance (used by FastClaw app)
export const getForInstance = query({
  args: { instanceId: v.string() },
  handler: async (ctx, { instanceId }) => {
    return await ctx.db
      .query("sessions")
      .withIndex("by_instanceId", (q) => q.eq("instanceId", instanceId))
      .collect();
  },
});

// Update instance heartbeat
export const heartbeat = mutation({
  args: {
    instanceId: v.string(),
    version: v.optional(v.string()),
  },
  handler: async (ctx, { instanceId, version }) => {
    const instance = await ctx.db
      .query("instances")
      .withIndex("by_instanceId", (q) => q.eq("instanceId", instanceId))
      .first();

    if (instance) {
      await ctx.db.patch(instance._id, {
        status: "online",
        lastSeenAt: Date.now(),
        ...(version ? { version } : {}),
      });
    }
  },
});

// Push identity from relay (parsed from IDENTITY.md)
export const pushIdentity = mutation({
  args: {
    instanceId: v.string(),
    identity: v.object({
      name: v.optional(v.string()),
      emoji: v.optional(v.string()),
    }),
  },
  handler: async (ctx, { instanceId, identity }) => {
    const instance = await ctx.db
      .query("instances")
      .withIndex("by_instanceId", (q) => q.eq("instanceId", instanceId))
      .first();
    if (instance) {
      await ctx.db.patch(instance._id, { identity });
    }
  },
});

// Push health data from relay
export const pushHealth = mutation({
  args: {
    instanceId: v.string(),
    healthData: v.object({
      model: v.optional(v.string()),
      activeSessionModel: v.optional(v.string()),
      contextTokens: v.optional(v.number()),
      sessionCount: v.optional(v.number()),
      heartbeatEnabled: v.optional(v.boolean()),
      heartbeatInterval: v.optional(v.string()),
      channels: v.optional(v.array(v.object({
        id: v.string(),
        label: v.string(),
        configured: v.boolean(),
        running: v.optional(v.boolean()),
        linked: v.optional(v.boolean()),
      }))),
      updatedAt: v.optional(v.number()),
    }),
  },
  handler: async (ctx, { instanceId, healthData }) => {
    const instance = await ctx.db
      .query("instances")
      .withIndex("by_instanceId", (q) => q.eq("instanceId", instanceId))
      .first();

    if (instance) {
      await ctx.db.patch(instance._id, {
        healthData: { ...healthData, updatedAt: Date.now() },
        status: "online",
        lastSeenAt: Date.now(),
      });
    }
  },
});

// Get instance status (used by FastClaw app)
export const getInstanceStatus = query({
  args: { instanceId: v.string() },
  handler: async (ctx, { instanceId }) => {
    const instance = await ctx.db
      .query("instances")
      .withIndex("by_instanceId", (q) => q.eq("instanceId", instanceId))
      .first();

    if (!instance) return null;

    // Consider offline if no heartbeat in 2 minutes
    const isOnline = Date.now() - instance.lastSeenAt < 2 * 60 * 1000;

    return {
      ...instance,
      status: isOnline ? "online" : "offline",
    };
  },
});
