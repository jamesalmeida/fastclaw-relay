import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const sync = mutation({
  args: {
    instanceId: v.string(),
    skills: v.array(v.object({
      name: v.string(),
      description: v.string(),
      emoji: v.optional(v.string()),
      eligible: v.boolean(),
      source: v.string(),
      homepage: v.optional(v.string()),
    })),
  },
  handler: async (ctx, { instanceId, skills }) => {
    const existing = await ctx.db
      .query("skills")
      .withIndex("by_instanceId", (q) => q.eq("instanceId", instanceId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, { skills, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("skills", { instanceId, skills, updatedAt: Date.now() });
    }
  },
});

export const get = query({
  args: { instanceId: v.string() },
  handler: async (ctx, { instanceId }) => {
    const doc = await ctx.db
      .query("skills")
      .withIndex("by_instanceId", (q) => q.eq("instanceId", instanceId))
      .first();

    return doc?.skills ?? [];
  },
});
