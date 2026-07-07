/**
 * Player image uploads. Images are stored as plain files on disk (NOT in state/the DB —
 * persistAll() rewrites every player row on every bid, so image bytes there would make
 * bidding slow). Only the bare filename lives in `player.image`; the bytes live here.
 *
 * The uploads dir is derived from DB_PATH exactly like the DB file itself, so it works the
 * same on localhost (repo-root ./uploads) and on Render (/data/uploads on the persistent
 * disk, surviving restarts/redeploys) — no environment-specific code, no extra env var.
 *
 * Uploads arrive as a base64 data URL inside the normal JSON admin POST (matches the
 * all-JSON admin action style; avoids a multipart dependency). Kept small by validation.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DB_PATH } = require('./db');

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(path.dirname(DB_PATH), 'uploads');

// Ensure the directory exists on boot (recursive: also creates /data if the disk mount is bare).
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const MAX_BYTES = 3 * 1024 * 1024;   // 3 MB decoded — a hero-reveal photo should be well under this
const EXT_BY_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** Magic-byte sniff so a mislabeled / non-image data URL is rejected regardless of its header. */
function sniffMime(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Decode + validate a base64 data URL and write it to a fresh file for `playerId`.
 * Returns { ok, filename } or { ok:false, error }. Does not touch state.
 */
function saveImage(playerId, dataUrl) {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(dataUrl || '').trim());
  if (!m) return { ok: false, error: 'Invalid image data.' };

  let buf;
  try { buf = Buffer.from(m[2], 'base64'); } catch { return { ok: false, error: 'Invalid image data.' }; }
  if (!buf.length) return { ok: false, error: 'Empty image.' };
  if (buf.length > MAX_BYTES) return { ok: false, error: 'Image too large (max 3 MB).' };

  const mime = sniffMime(buf);
  if (!mime || !EXT_BY_MIME[mime]) return { ok: false, error: 'Only JPG, PNG or WebP images are allowed.' };

  const filename = `p${playerId}-${crypto.randomBytes(4).toString('hex')}.${EXT_BY_MIME[mime]}`;
  try {
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), buf);
  } catch {
    return { ok: false, error: 'Could not save the image.' };
  }
  return { ok: true, filename };
}

/** Best-effort delete of a stored image file (orphans are tiny/harmless, so failures are ignored). */
function deleteImage(filename) {
  if (!filename) return;
  // Guard against path traversal — only ever touch a bare basename inside UPLOADS_DIR.
  const base = path.basename(String(filename));
  try { fs.unlinkSync(path.join(UPLOADS_DIR, base)); } catch { /* already gone / never existed */ }
}

module.exports = { UPLOADS_DIR, saveImage, deleteImage };
