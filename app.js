#!/usr/bin/env node
"use strict";
// Clean launcher for Cloady: generates an Xray config from env and runs the
// official Xray binary. Zero npm dependencies, no telemetry, no extra
// network calls besides fetching the pinned official Xray release
// (SHA256-verified, see fetch-xray.js) on first start.
// Protocol: VLESS + WebSocket, TLS terminated by the Cloady platform edge.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const UUID = process.env.UUID || "";
const WSPATH_RAW = process.env.WSPATH || "";
const PORT = Number(process.env.PORT || 3000);
const LISTEN = process.env.LISTEN || "0.0.0.0";
const archName = process.arch === "arm64" ? "arm64" : "amd64";
const archBin = path.join(__dirname, "xray-" + archName);
const XRAY_BIN = process.env.XRAY_BIN || archBin;
const NEEDS_FETCH = !process.env.XRAY_BIN && !fs.existsSync(XRAY_BIN);

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!uuidRe.test(UUID)) { console.error("UUID env must be a valid UUID"); process.exit(1); }
if (!WSPATH_RAW) { console.error("WSPATH env is required"); process.exit(1); }
const WSPATH = WSPATH_RAW.startsWith("/") ? WSPATH_RAW : "/" + WSPATH_RAW;

const config = {
  log: { loglevel: "warning" },
  inbounds: [{
    tag: "vless-ws-in",
    listen: LISTEN,
    port: PORT,
    protocol: "vless",
    settings: { clients: [{ id: UUID }], decryption: "none" },
    streamSettings: { network: "ws", security: "none", wsSettings: { path: WSPATH } },
    sniffing: { enabled: true, destOverride: ["http", "tls", "quic"] },
  }],
  outbounds: [
    { tag: "direct", protocol: "freedom", settings: { domainStrategy: "UseIPv4" } },
    { tag: "block", protocol: "blackhole" },
  ],
  routing: {
    domainStrategy: "IPIfNonMatch",
    rules: [{ type: "field", outboundTag: "block", protocol: ["bittorrent"] }],
  },
  dns: { servers: ["https://1.1.1.1/dns-query", "https://8.8.8.8/dns-query"], queryStrategy: "UseIPv4" },
};

const configPath = path.join(os.tmpdir(), "xray-config.json");
fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });

async function main() {
  let bin = XRAY_BIN;
  if (NEEDS_FETCH) bin = await require("./fetch-xray").ensureXray(__dirname);
  const child = spawn(bin, ["run", "-config", configPath], { stdio: "inherit" });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
  child.on("exit", (code) => { process.exit(code != null ? code : 1); });
}
main().catch((e) => { console.error("startup failed:", e.message); process.exit(1); });
