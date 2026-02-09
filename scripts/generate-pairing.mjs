#!/usr/bin/env node
/**
 * Generate a FastClaw pairing code + QR image.
 * Usage: node generate-pairing.mjs [--out /path/to/qr.png]
 * 
 * Outputs JSON to stdout: { code, convexUrl, qrPath }
 * Designed to be called by an OpenClaw agent to send the QR via any channel.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConvexHttpClient } from "convex/browser";

const FASTCLAW_CONFIG_PATH = path.join(os.homedir(), ".openclaw", "fastclaw", "config.json");

// Parse args
const args = process.argv.slice(2);
let outPath = path.join(os.tmpdir(), `fastclaw-pair-${Date.now()}.png`);
const outIdx = args.indexOf("--out");
if (outIdx !== -1 && args[outIdx + 1]) outPath = args[outIdx + 1];

try {
  const config = JSON.parse(await fs.readFile(FASTCLAW_CONFIG_PATH, "utf8"));
  const client = new ConvexHttpClient(config.convexUrl);

  // Generate pairing code
  const result = await client.mutation("pairing:createPairingCode", {
    instanceId: config.instanceId,
    instanceName: "OpenClaw",
  });

  const code = result.code;
  const qrData = JSON.stringify({ code, convexUrl: config.convexUrl });

  // Generate QR as PNG using canvas (no native deps)
  let qrSaved = false;
  try {
    const { default: QRCode } = await import("qrcode");
    await QRCode.toFile(outPath, qrData, { width: 400, margin: 2 });
    qrSaved = true;
  } catch {
    // qrcode module not available, try segno via python
    try {
      const { execSync } = await import("node:child_process");
      execSync(`python3 -c "import segno,json; segno.make(json.dumps({'code':'${code}','convexUrl':'${config.convexUrl}'})).save('${outPath}', scale=8, border=2)"`, { timeout: 10000 });
      qrSaved = true;
    } catch {
      // No QR generation available
    }
  }

  console.log(JSON.stringify({
    code,
    convexUrl: config.convexUrl,
    qrPath: qrSaved ? outPath : null,
    expiresIn: "5 minutes",
  }));

  process.exit(0);
} catch (err) {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
}
