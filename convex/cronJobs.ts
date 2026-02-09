import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const jobValidator = v.object({
  id: v.string(),
  name: v.optional(v.string()),
  enabled: v.boolean(),
  scheduleKind: v.string(),
  scheduleExpr: v.optional(v.string()),
  scheduleTz: v.optional(v.string()),
  scheduleAt: v.optional(v.number()),
  scheduleEveryMs: v.optional(v.number()),
  sessionTarget: v.string(),
  payloadKind: v.string(),
  payloadText: v.string(),
  lastRunAt: v.optional(v.number()),
  lastStatus: v.optional(v.string()),
  lastError: v.optional(v.string()),
  lastDurationMs: v.optional(v.number()),
  nextRunAt: v.optional(v.number()),
  deliveryMode: v.optional(v.string()),
});

export const sync = mutation({
  args: {
    instanceId: v.string(),
    jobs: v.array(jobValidator),
  },
  handler: async (ctx, { instanceId, jobs }) => {
    const existing = await ctx.db
      .query("cronJobs")
      .withIndex("by_instanceId", (q) => q.eq("instanceId", instanceId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, { jobs, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("cronJobs", { instanceId, jobs, updatedAt: Date.now() });
    }
  },
});

export const get = query({
  args: { instanceId: v.string() },
  handler: async (ctx, { instanceId }) => {
    const doc = await ctx.db
      .query("cronJobs")
      .withIndex("by_instanceId", (q) => q.eq("instanceId", instanceId))
      .first();

    return doc?.jobs ?? [];
  },
});
