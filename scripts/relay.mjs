import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { ConvexHttpClient } from "convex/browser";
import WebSocket from "ws";

const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";
const CONFIG_PATH = path.join(os.homedir(), ".openclaw", "fastclaw", "config.json");
const APP_POLL_MS = 2000;
const HEARTBEAT_MS = 30000;
const SESSION_SYNC_MS = 15000;

function nowMs() {
  return Date.now();
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function loadConfig() {
  const raw = await fs.readFile(CONFIG_PATH, "utf8");
  const cfg = JSON.parse(raw);

  if (!cfg.convexUrl) throw new Error(`Missing convexUrl in ${CONFIG_PATH}`);
  if (!cfg.instanceId) throw new Error(`Missing instanceId in ${CONFIG_PATH}`);

  return {
    convexUrl: cfg.convexUrl,
    instanceId: cfg.instanceId,
    instanceName: cfg.instanceName ?? os.hostname(),
    gatewayUrl: cfg.gatewayUrl ?? DEFAULT_GATEWAY_URL,
    gatewayToken: cfg.gatewayToken ?? process.env.OPENCLAW_GATEWAY_TOKEN ?? null,
  };
}

function makeDeviceIdentity(instanceId) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const deviceId = `fastclaw-relay-${createHash("sha256").update(instanceId).digest("hex").slice(0, 16)}`;
  const publicKeyB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");

  return { deviceId, privateKey, publicKeyB64 };
}

function extractSessions(payload) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.sessions)
      ? payload.sessions
      : [];

  return list
    .map((session) => {
      const sessionKey = session?.sessionKey ?? session?.key ?? session?.id;
      if (!sessionKey || typeof sessionKey !== "string") return null;

      const updatedAt = toNumber(
        session?.updatedAt ?? session?.updated_at ?? session?.lastMessageAt,
        nowMs()
      );
      const createdAt = toNumber(session?.createdAt ?? session?.created_at, updatedAt);
      const lastMessagePreview =
        typeof session?.lastMessagePreview === "string"
          ? session.lastMessagePreview
          : typeof session?.preview === "string"
            ? session.preview
            : typeof session?.lastMessage?.content === "string"
              ? session.lastMessage.content
              : "";

      const rawTitle =
          (typeof session?.label === "string" && session.label) ||
          (typeof session?.displayName === "string" && session.displayName) ||
          (typeof session?.title === "string" && session.title) ||
          (typeof session?.name === "string" && session.name) ||
          sessionKey;

      // Friendly names for well-known sessions
      const friendlyTitle = sessionKey === "agent:main:main" ? "Main Chat" : rawTitle;

      return {
        sessionKey,
        title: friendlyTitle,
        isPinned: Boolean(session?.isPinned ?? session?.pinned ?? false),
        lastMessagePreview,
        updatedAt,
        createdAt,
      };
    })
    .filter(Boolean);
}

function extractGatewayMessages(frame) {
  const payload = frame?.payload;
  const rawMessages = [];

  if (Array.isArray(payload?.messages)) rawMessages.push(...payload.messages);
  if (payload?.message && typeof payload.message === "object") rawMessages.push(payload.message);
  if (payload && payload.sessionKey && payload.content) rawMessages.push(payload);

  return rawMessages
    .map((m) => {
      const sessionKey = m?.sessionKey ?? m?.session_id ?? m?.session;
      const content = typeof m?.content === "string" ? m.content : typeof m?.text === "string" ? m.text : null;
      if (!sessionKey || !content) return null;

      const role = m?.role === "assistant" || m?.role === "system" || m?.role === "user" ? m.role : "assistant";
      const timestamp = toNumber(m?.timestamp ?? m?.ts ?? m?.createdAt, nowMs());

      return { sessionKey, role, content, timestamp };
    })
    .filter(Boolean);
}

class GatewayConnection {
  constructor(config) {
    this.url = config.gatewayUrl;
    this.token = config.gatewayToken;
    this.instanceId = config.instanceId;
    this.instanceName = config.instanceName;
    this.identity = makeDeviceIdentity(config.instanceId);

    this.ws = null;
    this.pending = new Map();
    this.handlers = new Set();
    this.connected = false;
    this.closed = false;
  }

  onFrame(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async open() {
    this.closed = false;
    this.ws = new WebSocket(this.url);

    const connected = new Promise((resolve, reject) => {
      let connectTimeout = null;
      let fallbackTimer = null;
      let settled = false;

      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimeout);
        clearTimeout(fallbackTimer);
        fn(value);
      };

      connectTimeout = setTimeout(() => {
        settle(reject, new Error("Gateway connect timeout"));
      }, 15000);

      const sendConnect = async (challenge) => {
        try {
          const payload = {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: "gateway-client",
              displayName: "FastClaw Relay",
              version: "1.0.0",
              platform: process.platform,
              mode: "backend",
            },
            role: "operator",
            scopes: ["operator.read", "operator.write"],
            caps: [],
            auth: { token: this.token },
          };

          console.log("sending connect frame...");
          const response = await this.request("connect", payload, 12000);
          console.log("connect response:", JSON.stringify(response).slice(0, 300));
          const type = response?.type ?? response?.event;
          if (type !== "hello-ok") {
            throw new Error(`Unexpected connect response type: ${type ?? "unknown"}`);
          }

          this.serverVersion = response?.server?.version ?? "unknown";
          this.connected = true;
          settle(resolve);
        } catch (err) {
          settle(reject, err);
        }
      };

      this.ws.once("open", () => {
        fallbackTimer = setTimeout(() => {
          void sendConnect(null);
        }, 200);
      });

      this.ws.on("message", (raw) => {
        const frame = parseJson(String(raw));
        if (!frame) return;

        if (frame.id && this.pending.has(frame.id)) {
          const p = this.pending.get(frame.id);
          clearTimeout(p.timer);
          this.pending.delete(frame.id);

          if (frame.ok === false) {
            p.reject(new Error(frame.error?.message ?? "Gateway RPC error"));
          } else {
            p.resolve(frame.payload ?? frame.result ?? frame);
          }
          return;
        }

        if (frame.type === "connect.challenge" || frame.event === "connect.challenge") {
          console.log("received challenge, sending connect...");
          void sendConnect(frame.payload ?? frame.data ?? {});
          return;
        }

        for (const handler of this.handlers) handler(frame);
      });

      this.ws.once("error", (err) => {
        settle(reject, err);
      });

      this.ws.once("close", () => {
        if (!this.connected) settle(reject, new Error("Gateway closed before connect"));
      });
    });

    await connected;
  }

  request(method, payload, timeoutMs = 10000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Gateway socket is not open"));
    }

    const id = randomUUID();
    const frame = { type: "req", id, method, params: payload };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gateway RPC timeout for ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(frame));
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;

    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Gateway connection closing"));
    }
    this.pending.clear();

    if (!this.ws) return;

    const ws = this.ws;
    this.ws = null;

    await new Promise((resolve) => {
      const done = () => resolve();
      ws.once("close", done);
      ws.once("error", done);
      try {
        ws.close(1000, "fastclaw shutdown");
      } catch {
        resolve();
      }
      setTimeout(done, 500).unref?.();
    });
  }

  waitForClose() {
    if (!this.ws) return Promise.resolve();
    return new Promise((resolve) => {
      this.ws.once("close", () => {
        this.connected = false;
        resolve();
      });
      this.ws.once("error", () => {
        this.connected = false;
        resolve();
      });
    });
  }
}

class Relay {
  constructor(config) {
    this.config = config;
    this.convex = new ConvexHttpClient(config.convexUrl);

    this.running = true;
    this.reconnectAttempt = 0;
    this.recentGatewayMessageHashes = new Map();
    this.pendingDeltas = new Map();
    this.conn = null;
  }

  async start() {
    console.log("fastclaw relay starting...");

    while (this.running) {
      this.conn = new GatewayConnection(this.config);

      try {
        await this.conn.open();
        this.reconnectAttempt = 0;
        console.log(`connected to gateway at ${this.config.gatewayUrl}`);

        await this.runConnected(this.conn);
      } catch (err) {
        if (!this.running) break;
        console.error(`connection error: ${err.message}`);
      } finally {
        await this.conn.close().catch(() => {});
        this.conn = null;
      }

      if (!this.running) break;

      this.reconnectAttempt += 1;
      const backoff = Math.min(30000, 1000 * 2 ** Math.min(this.reconnectAttempt, 5));
      const jitter = Math.floor(Math.random() * 500);
      const waitMs = backoff + jitter;
      console.log(`reconnecting in ${waitMs}ms`);
      await sleep(waitMs);
    }

    console.log("fastclaw relay stopped");
  }

  async runConnected(conn) {
    let stopping = false;

    const onFrame = (frame) => {
      const evt = frame?.event ?? frame?.type;
      if (evt && evt !== "tick" && evt !== "health") {
        console.log(`[frame] event=${evt} payload=${JSON.stringify(frame?.payload ?? frame).slice(0, 300)}`);
      }
      // Gateway broadcasts "chat" events with state: delta|final|error
      if (evt === "chat") {
        const p = frame?.payload ?? frame;
        const runId = p?.runId;
        const sessionKey = p?.sessionKey;
        if (runId && sessionKey) {
          if (p?.state === "delta" && p?.message) {
            // Track latest accumulated text per runId
            let text = "";
            if (Array.isArray(p.message.content)) {
              text = p.message.content
                .filter((c) => c?.type === "text")
                .map((c) => c.text)
                .join("\n");
            } else if (typeof p.message.content === "string") {
              text = p.message.content;
            }
            if (text) this.pendingDeltas.set(runId, { sessionKey, text, timestamp: p.message.timestamp ?? nowMs() });
          } else if (p?.state === "final") {
            // Push final message (from final payload or accumulated delta)
            let text = "";
            if (p?.message) {
              if (Array.isArray(p.message.content)) {
                text = p.message.content.filter((c) => c?.type === "text").map((c) => c.text).join("\n");
              } else if (typeof p.message.content === "string") {
                text = p.message.content;
              }
            }
            const delta = this.pendingDeltas.get(runId);
            this.pendingDeltas.delete(runId);
            const finalText = text || delta?.text || "";
            if (finalText.trim()) {
              void this.pushChatEvent({ sessionKey, message: { role: "assistant", content: finalText, timestamp: delta?.timestamp ?? nowMs() } });
            }
          }
        }
      }

      if (evt === "sessions.updated") {
        void this.syncSessions(conn);
      }
    };

    const off = conn.onFrame(onFrame);

    const appPoll = setInterval(() => {
      void this.forwardUnsyncedAppMessages(conn);
    }, APP_POLL_MS);

    const heartbeat = setInterval(() => {
      void this.sendHeartbeat();
    }, HEARTBEAT_MS);

    const sessionSync = setInterval(() => {
      void this.syncSessions(conn);
    }, SESSION_SYNC_MS);

    const healthSync = setInterval(() => {
      void this.syncHealth(conn);
      void this.syncCronJobs();
    }, 60_000);

    const cronActionsPoll = setInterval(() => {
      void this.processCronActions();
    }, 5_000);

    console.log("starting relay loops (heartbeat, session sync, health, app poll)...");
    await this.sendHeartbeat();
    console.log("heartbeat sent");
    await this.syncSessions(conn);
    console.log("sessions synced");
    await this.syncHealth(conn);
    console.log("health synced");
    await this.syncIdentity();
    console.log("identity synced");
    await this.syncSkills();
    console.log("skills synced");
    await this.syncCronJobs();
    console.log("cron jobs synced");
    await this.syncHistoryForSessions(conn);
    console.log("history synced");
    await this.forwardUnsyncedAppMessages(conn);
    console.log("initial app message check done, entering wait loop...");

    try {
      await conn.waitForClose();
    } finally {
      if (!stopping) {
        stopping = true;
        off();
        clearInterval(appPoll);
        clearInterval(heartbeat);
        clearInterval(sessionSync);
        clearInterval(healthSync);
        clearInterval(cronActionsPoll);
      }
    }
  }

  async syncHealth(conn) {
    try {
      // Fetch both health and status for complete data
      const [healthPayload, statusPayload] = await Promise.all([
        conn.request("health", {}).catch(() => null),
        conn.request("status", {}).catch(() => null),
      ]);

      const h = healthPayload?.status ?? healthPayload ?? {};
      const s = statusPayload?.status ?? statusPayload ?? {};

      // Channels from health endpoint
      const channels = [];
      const channelOrder = h?.channelOrder ?? Object.keys(h?.channels ?? {});
      const channelLabels = h?.channelLabels ?? {};

      for (const id of channelOrder) {
        const ch = h?.channels?.[id];
        if (!ch) continue;
        channels.push({
          id,
          label: channelLabels[id] ?? id,
          configured: ch.configured ?? false,
          running: ch.running ?? false,
          linked: ch.linked ?? false,
        });
      }

      // Model/context from status endpoint (has defaults), fallback to health
      const defaults = s?.sessions?.defaults ?? h?.agents?.[0]?.sessions?.defaults;
      const sessionCount = s?.sessions?.count ?? h?.sessions?.count;

      // Active session model (agent:main:main is the primary session)
      const recent = s?.sessions?.recent ?? [];
      const mainSession = recent.find((r) => r.key === "agent:main:main") ?? recent[0];
      const activeSessionModel = mainSession?.model ?? undefined;

      // Heartbeat from health endpoint
      const agents = h?.agents;
      const hbAgents = s?.heartbeat?.agents;

      // Version from connect response
      const version = conn.serverVersion ?? h?.server?.version ?? "unknown";

      const healthData = {
        model: defaults?.model ?? undefined,
        activeSessionModel: activeSessionModel !== defaults?.model ? activeSessionModel : undefined,
        contextTokens: defaults?.contextTokens ?? undefined,
        sessionCount: sessionCount ?? undefined,
        heartbeatEnabled: agents?.[0]?.heartbeat?.enabled ?? hbAgents?.[0]?.enabled ?? undefined,
        heartbeatInterval: agents?.[0]?.heartbeat?.every ?? hbAgents?.[0]?.every ?? undefined,
        channels,
      };

      await this.convex.mutation("sessions:pushHealth", {
        instanceId: this.config.instanceId,
        healthData,
      });

      // Also update version in heartbeat
      await this.convex.mutation("sessions:heartbeat", {
        instanceId: this.config.instanceId,
        version,
      });
    } catch (err) {
      if (this.running) console.error(`health sync failed: ${err.message}`);
    }
  }

  async syncIdentity() {
    try {
      // Find workspace dir from config or common locations
      const homeDir = process.env.HOME || process.env.USERPROFILE;
      const candidates = [
        path.join(homeDir, "clawd", "IDENTITY.md"),
        path.join(homeDir, ".openclaw", "workspace", "IDENTITY.md"),
      ];
      let content = null;
      for (const p of candidates) {
        try {
          content = await fs.readFile(p, "utf-8");
          break;
        } catch {}
      }
      if (!content) return;

      // Parse name and emoji from IDENTITY.md
      const nameMatch = content.match(/\*\*Name:\*\*\s*(.+)/);
      const emojiMatch = content.match(/\*\*Emoji:\*\*\s*(\S+)/);
      const identity = {};
      if (nameMatch) identity.name = nameMatch[1].trim().replace(/\s*\(.*\)$/, "");
      if (emojiMatch) identity.emoji = emojiMatch[1].trim();
      if (!identity.name && !identity.emoji) return;

      await this.convex.mutation("sessions:pushIdentity", {
        instanceId: this.config.instanceId,
        identity,
      });
    } catch (err) {
      if (this.running) console.error(`identity sync failed: ${err.message}`);
    }
  }

  async syncSkills() {
    try {
      const raw = execSync("openclaw skills list --json", {
        encoding: "utf-8",
        timeout: 15000,
      });
      const data = JSON.parse(raw);
      const skills = (data.skills ?? []).map((s) => ({
        name: s.name,
        description: s.description ?? "",
        emoji: s.emoji ?? undefined,
        eligible: s.eligible ?? false,
        source: s.source ?? "unknown",
        homepage: s.homepage ?? undefined,
      }));

      await this.convex.mutation("skills:sync", {
        instanceId: this.config.instanceId,
        skills,
      });
    } catch (err) {
      if (this.running) console.error(`skills sync failed: ${err.message}`);
    }
  }

  async syncCronJobs() {
    try {
      const raw = execSync("openclaw cron list --json", {
        encoding: "utf-8",
        timeout: 15000,
      });
      const data = JSON.parse(raw);
      const jobs = (data.jobs ?? []).map((j) => ({
        id: j.id,
        name: j.name ?? undefined,
        enabled: j.enabled ?? false,
        scheduleKind: j.schedule?.kind ?? "unknown",
        scheduleExpr: j.schedule?.expr ?? undefined,
        scheduleTz: j.schedule?.tz ?? undefined,
        scheduleAt: j.schedule?.at ? new Date(j.schedule.at).getTime() : undefined,
        scheduleEveryMs: j.schedule?.everyMs ?? undefined,
        sessionTarget: j.sessionTarget ?? "main",
        payloadKind: j.payload?.kind ?? "unknown",
        payloadText: j.payload?.text ?? j.payload?.message ?? "",
        lastRunAt: j.state?.lastRunAtMs ?? undefined,
        lastStatus: j.state?.lastStatus ?? undefined,
        lastError: j.state?.lastError ?? undefined,
        lastDurationMs: j.state?.lastDurationMs ?? undefined,
        nextRunAt: j.state?.nextRunAtMs ?? undefined,
        deliveryMode: j.delivery?.mode ?? undefined,
      }));

      await this.convex.mutation("cronJobs:sync", {
        instanceId: this.config.instanceId,
        jobs,
      });
    } catch (err) {
      if (this.running) console.error(`cron jobs sync failed: ${err.message}`);
    }
  }

  async processCronActions() {
    try {
      const actions = await this.convex.query("cronJobs:getPendingActions", {
        instanceId: this.config.instanceId,
      });
      if (!actions || actions.length === 0) return;

      for (const action of actions) {
        try {
          const cmdMap = {
            enable: `openclaw cron enable ${action.jobId}`,
            disable: `openclaw cron disable ${action.jobId}`,
            run: `openclaw cron run ${action.jobId}`,
            remove: `openclaw cron rm ${action.jobId}`,
          };
          const cmd = cmdMap[action.action];
          if (!cmd) throw new Error(`Unknown cron action: ${action.action}`);
          execSync(cmd, { encoding: "utf-8", timeout: 15000 });
          await this.convex.mutation("cronJobs:completeAction", {
            actionId: action._id,
            status: "done",
          });
        } catch (err) {
          await this.convex.mutation("cronJobs:completeAction", {
            actionId: action._id,
            status: "error",
            error: err.message?.slice(0, 200),
          });
        }
      }
      // Refresh cron state after processing actions
      await this.syncCronJobs();
    } catch (err) {
      if (this.running) console.error(`cron actions processing failed: ${err.message}`);
    }
  }

  async syncSessions(conn) {
    try {
      const payload = await conn.request("sessions.list", {});
      const sessions = extractSessions(payload);
      if (sessions.length === 0) return;

      await this.convex.mutation("sessions:syncFromGateway", {
        instanceId: this.config.instanceId,
        sessions,
      });
    } catch (err) {
      if (this.running) console.error(`session sync failed: ${err.message}`);
    }
  }

  async pushChatEvent(payload) {
    try {
      const sessionKey = payload?.sessionKey;
      const msg = payload?.message;
      if (!sessionKey || !msg) return;

      let text = "";
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content
          .filter((part) => part?.type === "text" && typeof part?.text === "string")
          .map((part) => part.text)
          .join("\n");
      }
      if (!text.trim()) return;

      const role = msg.role === "user" ? "user" : msg.role === "assistant" ? "assistant" : "system";
      const timestamp = toNumber(msg.timestamp, nowMs());

      await this.convex.mutation("messages:pushFromGateway", {
        instanceId: this.config.instanceId,
        sessionKey,
        role,
        content: text.slice(0, 4000),
        timestamp,
      });
      console.log(`pushed ${role} message to Convex for ${sessionKey}`);
    } catch (err) {
      console.error(`pushChatEvent failed: ${err.message}`);
    }
  }

  async syncHistoryForSessions(conn) {
    try {
      // Get all sessions from Convex
      const sessions = await this.convex.query("sessions:getForInstance", {
        instanceId: this.config.instanceId,
      });
      if (!Array.isArray(sessions) || sessions.length === 0) return;

      for (const session of sessions) {
        const sessionKey = session?.sessionKey;
        if (!sessionKey) continue;

        try {
          const payload = await conn.request("chat.history", { sessionKey, limit: 50 });
          const rawMessages = payload?.messages ?? [];
          const messages = [];

          for (const msg of rawMessages) {
            if (msg.role === "toolResult" || msg.role === "tool") continue;

            // Extract text from structured content
            let text = "";
            if (typeof msg.content === "string") {
              text = msg.content;
            } else if (Array.isArray(msg.content)) {
              text = msg.content
                .filter((part) => part?.type === "text" && typeof part?.text === "string")
                .map((part) => part.text)
                .join("\n");
            }

            if (!text.trim()) continue;

            const role = msg.role === "user" ? "user" : msg.role === "assistant" ? "assistant" : "system";
            messages.push({
              role,
              content: text.slice(0, 4000), // cap length
              timestamp: toNumber(msg.timestamp ?? msg.ts, nowMs()),
            });
          }

          if (messages.length === 0) continue;

          // Push to Convex
          for (const m of messages) {
            try {
              await this.convex.mutation("messages:pushFromGateway", {
                instanceId: this.config.instanceId,
                sessionKey,
                role: m.role,
                content: m.content,
                timestamp: m.timestamp,
              });
            } catch {
              // skip duplicates or errors
            }
          }
          console.log(`synced ${messages.length} messages for ${sessionKey}`);
        } catch (err) {
          console.log(`history sync failed for ${sessionKey}: ${err.message}`);
        }
      }
    } catch (err) {
      if (this.running) console.error(`history sync failed: ${err.message}`);
    }
  }

  async forwardUnsyncedAppMessages(conn) {
    try {
      const unsynced = await this.convex.query("messages:getUnsyncedFromApp", {
        instanceId: this.config.instanceId,
      });

      if (!Array.isArray(unsynced) || unsynced.length === 0) return;
      console.log(`found ${unsynced.length} unsynced app messages`);

      const syncedIds = [];
      for (const message of unsynced) {
        console.log(`forwarding to gateway: "${message.content}" → session ${message.sessionKey}`);
        const sent = await this.sendToGateway(conn, message);
        console.log(`forward result: ${sent ? "OK" : "FAILED"}`);
        if (sent && message?._id) syncedIds.push(message._id);
      }

      if (syncedIds.length > 0) {
        await this.convex.mutation("messages:markSynced", { messageIds: syncedIds });
      }
    } catch (err) {
      if (this.running) console.error(`app message forward failed: ${err.message}`);
    }
  }

  async sendToGateway(conn, message) {
    const sessionKey = message?.sessionKey;
    const content = message?.content;
    if (!sessionKey || !content) return false;

    const idempotencyKey = typeof message?._id === "string" ? message._id : randomUUID();

    const attempts = [
      { method: "chat.send", payload: { sessionKey, message: content, idempotencyKey } },
    ];

    for (const attempt of attempts) {
      try {
        console.log(`trying ${attempt.method}...`);
        const response = await conn.request(attempt.method, attempt.payload);
        console.log(`${attempt.method} response:`, JSON.stringify(response).slice(0, 300));
        const frame = { payload: response };
        await this.pushGatewayMessages(extractGatewayMessages(frame));
        return true;
      } catch (err) {
        console.log(`${attempt.method} failed: ${err.message}`);
      }
    }

    return false;
  }

  hashGatewayMessage(msg) {
    return createHash("sha1")
      .update(`${msg.sessionKey}|${msg.role}|${msg.content}|${msg.timestamp}`)
      .digest("hex");
  }

  pruneRecentHashes() {
    const cutoff = nowMs() - 10 * 60 * 1000;
    for (const [hash, ts] of this.recentGatewayMessageHashes.entries()) {
      if (ts < cutoff) this.recentGatewayMessageHashes.delete(hash);
    }
  }

  async pushGatewayMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return;

    this.pruneRecentHashes();

    for (const msg of messages) {
      const hash = this.hashGatewayMessage(msg);
      if (this.recentGatewayMessageHashes.has(hash)) continue;

      try {
        await this.convex.mutation("messages:pushFromGateway", {
          instanceId: this.config.instanceId,
          sessionKey: msg.sessionKey,
          role: msg.role,
          content: msg.content,
          timestamp: msg.timestamp,
        });

        this.recentGatewayMessageHashes.set(hash, nowMs());
      } catch (err) {
        if (this.running) console.error(`push gateway message failed: ${err.message}`);
      }
    }
  }

  async sendHeartbeat() {
    try {
      await this.convex.mutation("sessions:heartbeat", {
        instanceId: this.config.instanceId,
      });
    } catch (err) {
      if (this.running) console.error(`heartbeat failed: ${err.message}`);
    }
  }

  async stop() {
    this.running = false;
    if (this.conn) await this.conn.close();
  }
}

async function main() {
  const config = await loadConfig();

  if (!config.gatewayToken) {
    throw new Error(
      `Missing gateway token. Set OPENCLAW_GATEWAY_TOKEN or include gatewayToken in ${CONFIG_PATH}`
    );
  }

  const relay = new Relay(config);

  const shutdown = async (signal) => {
    console.log(`received ${signal}, shutting down...`);
    await relay.stop();
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await relay.start();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
