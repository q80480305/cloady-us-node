"use strict";
// Fetches the official Xray-core binary for this machine's architecture,
// verifies its SHA256 against the values pinned below (from the official
// release .dgst files), and extracts only the `xray` binary.
// This is the ONLY network call this package makes besides Xray itself.
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

const VERSION = "v26.10.21";
const ASSETS = {
  amd64: { file: "Xray-linux-64.zip", sha256: "0eec3ed4163c273d8c8bf821f7d219e257921cf584aa3fb970715e458e631978" },
  arm64: { file: "Xray-linux-arm64-v8a.zip", sha256: "d1304946c486d98e6b886e9b931eaaaebb23835b30e217638037b7f2721d4e9c" },
};

function download(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "clean-xhttp-fetch" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error("too many redirects"));
        return resolve(download(res.headers.location, dest, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("download HTTP " + res.statusCode)); }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on("finish", () => out.close(() => resolve()));
      out.on("error", reject);
    }).on("error", reject);
  });
}

// Minimal ZIP reader: extract one entry (stored or deflated) by name.
function extractEntry(zipBuf, entryName, dest) {
  // Find End Of Central Directory record (scan from the end for its signature).
  let eocd = -1;
  for (let i = zipBuf.length - 22; i >= 0; i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = zipBuf.readUInt16LE(eocd + 10);
  let off = zipBuf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (zipBuf.readUInt32LE(off) !== 0x02014b50) throw new Error("bad central directory");
    const method = zipBuf.readUInt16LE(off + 10);
    const compSize = zipBuf.readUInt32LE(off + 20);
    const nameLen = zipBuf.readUInt16LE(off + 28);
    const extraLen = zipBuf.readUInt16LE(off + 30);
    const commentLen = zipBuf.readUInt16LE(off + 32);
    const localOff = zipBuf.readUInt32LE(off + 42);
    const name = zipBuf.toString("utf8", off + 46, off + 46 + nameLen);
    if (name === entryName) {
      if (zipBuf.readUInt32LE(localOff) !== 0x04034b50) throw new Error("bad local header");
      const lNameLen = zipBuf.readUInt16LE(localOff + 26);
      const lExtraLen = zipBuf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const comp = zipBuf.subarray(dataStart, dataStart + compSize);
      const data = method === 0 ? comp : zlib.inflateRawSync(comp);
      fs.writeFileSync(dest, data, { mode: 0o755 });
      return;
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error("entry not found in zip: " + entryName);
}

async function ensureXray(dir) {
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const asset = ASSETS[arch];
  const binPath = path.join(dir, "xray-" + arch);
  if (fs.existsSync(binPath)) return binPath;
  const zipPath = path.join(dir, "xray-download.zip");
  const url = `https://github.com/XTLS/Xray-core/releases/download/${VERSION}/${asset.file}`;
  console.log("fetching official Xray", VERSION, "for", arch);
  await download(url, zipPath);
  const hash = crypto.createHash("sha256").update(fs.readFileSync(zipPath)).digest("hex");
  if (hash !== asset.sha256) {
    fs.unlinkSync(zipPath);
    throw new Error("SHA256 mismatch for Xray release zip");
  }
  extractEntry(fs.readFileSync(zipPath), "xray", binPath);
  fs.unlinkSync(zipPath);
  console.log("xray binary ready (sha256 verified)");
  return binPath;
}

module.exports = { ensureXray };
if (require.main === module) {
  ensureXray(__dirname).then((p) => console.log(p)).catch((e) => { console.error(e.message); process.exit(1); });
}
