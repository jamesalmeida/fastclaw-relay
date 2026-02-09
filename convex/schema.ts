import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Registered OpenClaw instances
  instances: defineTable({
    instanceId: v.string(), // unique ID for this OpenClaw install
    name: v.string(), // user-friendly name (e.g. "James's Mac Mini")
    status: v.union(v.literal("online"), v.literal("offline")),
    version: v.optional(v.string()), // OpenClaw version
    lastSeenAt: v.number(), // timestamp
    createdAt: v.number(),
    // Rich health data from gateway
    healthData: v.optional(v.object({
      model: v.optional(v.string()),
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
    })),
  })
    .index("by_instanceId", ["instanceId"]),

  // Paired devices (FastClaw app instances)
  devices: defineTable({
    instanceId: v.string(), // which OpenClaw instance this device is paired to
    deviceId: v.string(), // unique device identifier
    name: v.string(), // e.g. "James's iPhone"
    platform: v.string(), // "ios"
    pairedAt: v.number(),
    lastSeenAt: v.number(),
  })
    .index("by_instanceId", ["instanceId"])
    .index("by_deviceId", ["deviceId"]),

  // Chat sessions
  sessions: defineTable({
    instanceId: v.string(),
    sessionKey: v.string(), // OpenClaw session key
    title: v.string(),
    isPinned: v.boolean(),
    lastMessagePreview: v.string(),
    updatedAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_instanceId", ["instanceId"])
    .index("by_instanceId_sessionKey", ["instanceId", "sessionKey"]),

  // Messages
  messages: defineTable({
    instanceId: v.string(),
    sessionKey: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant"), v.literal("system")),
    content: v.string(),
    timestamp: v.number(),
    // For messages originating from FastClaw app
    source: v.union(v.literal("gateway"), v.literal("fastclaw")),
    // Track sync status
    synced: v.boolean(),
  })
    .index("by_session", ["instanceId", "sessionKey", "timestamp"])
    .index("by_unsynced", ["instanceId", "synced"]),

  // One-time pairing codes (QR code content)
  pairingCodes: defineTable({
    code: v.string(), // 6-digit or UUID
    instanceId: v.string(),
    expiresAt: v.number(), // 5 min TTL
    claimed: v.boolean(),
    claimedByDeviceId: v.optional(v.string()),
  })
    .index("by_code", ["code"]),
});
