'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

/**
 * Static asset server tuned for a room full of phones on one Wi-Fi radio.
 *
 * Three things matter here that `express.static` does not do for us:
 *
 *  1. **Compression, done once.** Assets are gzipped at startup and the result
 *     is held in memory, so 60 simultaneous requests cost no CPU and no
 *     re-compression. The CSS and JS shrink by roughly 70%.
 *  2. **Real caching.** Previously every response carried `no-store`, so each
 *     navigation re-downloaded the whole shell. Assets now revalidate cheaply
 *     with an ETag and return 304 instead of the full body.
 *  3. **HTML stays fresh.** The exam pages must never be served stale, or a
 *     student could get a shell that skips the pre-exam attempt check, so HTML
 *     revalidates on every load while CSS/JS may sit in cache.
 */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// Already-compressed formats gain nothing and waste memory.
const COMPRESSIBLE = /^(text\/|application\/(json|javascript)|image\/svg)/;

// How long a phone may reuse CSS/JS without asking. Long enough to cover a
// whole exam sitting, short enough that an update lands the same day.
const ASSET_MAX_AGE = 600;

const GZIP_MIN_BYTES = 512;

function createStaticServer(rootDir) {
  const cache = new Map(); // urlPath -> entry

  function load(urlPath) {
    const relative = urlPath.replace(/^\/+/, '');
    const full = path.join(rootDir, relative);

    // Never serve outside the public directory.
    const resolved = path.resolve(full);
    if (resolved !== path.resolve(rootDir)
      && !resolved.startsWith(path.resolve(rootDir) + path.sep)) {
      return null;
    }

    let stat;
    try {
      stat = fs.statSync(resolved);
      if (!stat.isFile()) return null;
    } catch {
      return null;
    }

    const cached = cache.get(urlPath);
    // mtime + size act as the version, so editing a file takes effect at once.
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached;
    }

    const body = fs.readFileSync(resolved);
    const ext = path.extname(resolved).toLowerCase();
    const type = TYPES[ext] || 'application/octet-stream';
    const hash = crypto.createHash('sha1').update(body).digest('base64url').slice(0, 20);

    const entry = {
      body,
      type,
      isHtml: ext === '.html',
      etag: `"${hash}"`,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      gzip: null,
    };

    if (COMPRESSIBLE.test(type) && body.length >= GZIP_MIN_BYTES) {
      const gz = zlib.gzipSync(body, { level: zlib.constants.Z_BEST_COMPRESSION });
      // Only keep it if it actually helps.
      if (gz.length < body.length * 0.95) entry.gzip = gz;
    }

    cache.set(urlPath, entry);
    return entry;
  }

  function send(req, res, entry) {
    res.setHeader('Content-Type', entry.type);
    res.setHeader('ETag', entry.etag);
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Cache-Control', entry.isHtml
      // Revalidate the shell every time; a 304 is a few hundred bytes.
      ? 'no-cache, must-revalidate'
      : `public, max-age=${ASSET_MAX_AGE}, must-revalidate`);

    // Conditional request: answer 304 and send no body at all.
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').some((tag) => tag.trim() === entry.etag)) {
      res.status(304).end();
      return;
    }

    const accepts = String(req.headers['accept-encoding'] || '');
    const useGzip = entry.gzip && /\bgzip\b/.test(accepts);
    const payload = useGzip ? entry.gzip : entry.body;

    if (useGzip) res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', payload.length);

    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(payload);
  }

  /** Express middleware. Falls through to `next()` when there is no such file. */
  function middleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    let urlPath;
    try {
      urlPath = decodeURIComponent(req.path);
    } catch {
      return next();
    }
    if (urlPath.includes('\0')) return next();

    const candidate = urlPath.endsWith('/') ? `${urlPath}index.html` : urlPath;
    const entry = load(candidate);
    if (!entry) return next();
    return send(req, res, entry);
  }

  /** Serves one known file by relative path (for the /exam and /admin routes). */
  function sendFile(req, res, relative) {
    const entry = load(`/${relative.replace(/^\/+/, '')}`);
    if (!entry) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    send(req, res, entry);
  }

  /** Warms the cache so the first student does not pay the gzip cost. */
  function warm() {
    const summary = [];
    const walk = (dir, prefix) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) walk(full, `${prefix}/${name}`);
        else {
          const entry = load(`${prefix}/${name}`);
          if (entry) {
            summary.push({
              path: `${prefix}/${name}`,
              raw: entry.body.length,
              gzip: entry.gzip ? entry.gzip.length : null,
            });
          }
        }
      }
    };
    try { walk(rootDir, ''); } catch { /* nothing to warm */ }
    return summary;
  }

  return { middleware, sendFile, warm };
}

module.exports = { createStaticServer };
