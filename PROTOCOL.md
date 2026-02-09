# OpenClaw Gateway Protocol Reference

Discovered by reverse-engineering the gateway internals. Use this for Codex context.

## Connection

### Frame Format
All frames are JSON: `{ type: "req", id: "<uuid>", method: "<method>", params: <object> }`
Responses: `{ type: "res", id: "<uuid>", ok: true/false, payload: <object> }`
Events: `{ type: "evt", event: "<name>", payload: <object>, seq: <number> }`

### Connect Params
```json
{
  "minProtocol": 3,
  "maxProtocol": 3,
  "client": {
    "id": "gateway-client",
    "displayName": "FastClaw Relay",
    "version": "1.0.0",
    "platform": "darwin",
    "mode": "backend"
  },
  "role": "operator",
  "scopes": ["operator.read", "operator.write"],
  "caps": [],
  "auth": { "token": "<gateway-token>" }
}
```

### Valid Client IDs
webchat-ui, openclaw-control-ui, webchat, cli, gateway-client, openclaw-macos, openclaw-ios, openclaw-android, node-host, test

### Valid Client Modes
webchat, cli, ui, backend, node, probe, test

## Methods

### chat.send
Send a message to a session.
```json
{ "sessionKey": "agent:main:main", "message": "Hello", "idempotencyKey": "<optional-uuid>" }
```
Response: `{ "runId": "...", "status": "started" }`

### chat.history
Get message history for a session.
```json
{ "sessionKey": "agent:main:main", "limit": 50 }
```
Response: `{ "sessionKey": "...", "sessionId": "...", "messages": [...] }`
Messages have structured content: `{ role: "user"|"assistant"|"tool"|"toolResult", content: [{ type: "text", text: "..." }, { type: "toolCall", ... }] }`

### sessions.list
List all sessions.
```json
{}
```
Response: `{ "sessions": [{ "key": "...", "displayName": "...", "label": "...", "updatedAt": ..., ... }] }`

### sessions.preview
Get preview snippets for sessions.
```json
{ "keys": ["agent:main:main"], "limit": 5 }
```

## Events (Broadcast)

### chat (state: delta)
Streaming text delta. Sent periodically (throttled ~150ms).
```json
{
  "runId": "...",
  "sessionKey": "agent:main:main",
  "seq": 123,
  "state": "delta",
  "message": {
    "role": "assistant",
    "content": [{ "type": "text", "text": "accumulated text so far" }],
    "timestamp": 1234567890
  }
}
```

### chat (state: final)
Run completed. May or may not include message (sometimes empty if response was tool-only).
```json
{
  "runId": "...",
  "sessionKey": "agent:main:main",
  "seq": 456,
  "state": "final",
  "message": { "role": "assistant", "content": [...], "timestamp": ... }
}
```
**Important:** Accumulate text from deltas and use on final — final payload often has no message.

### chat (state: error)
Run errored.

### agent
Low-level agent streaming events. Higher frequency than chat deltas.
```json
{
  "runId": "...",
  "stream": "assistant",
  "data": { "text": "full text", "delta": "new chunk" },
  "sessionKey": "...",
  "seq": ...,
  "ts": ...
}
```

### health
Periodic health status broadcasts.

### tick
Periodic tick events (high frequency, ignore).
