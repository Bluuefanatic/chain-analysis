/**
 * src/web/server.js
 *
 * Backend API server for the Sherlock chain-analysis web visualiser.
 *
 * Endpoints
 * ─────────
 *   GET /api/health          → { ok: true, reports: number }
 *   GET /api/block/:height   → block section from the loaded reports
 *   GET /api/tx/:txid        → transaction entry + block context
 *
 * Data source
 * ───────────
 * On startup the server reads every *.json file inside <cwd>/out/.
 * Each file is expected to conform to the report schema produced by
 * src/reports/jsonReport.js.  The data is kept in memory; a 404 is
 * returned for any height / txid that is not present.
 *
 * Configuration
 * ─────────────
 *   PORT   — listening port (default: 3000)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Vite build output — served as static assets
const DIST_DIR = path.resolve(__dirname, 'dist');

// ── Data store ────────────────────────────────────────────────────────────────

/**
 * In-memory data loaded once from out/*.json.
 *
 * blocksByHeight : Map<number, object>   block_height → block object
 * txIndex        : Map<string, object>   txid → { block_hash, block_height, tx }
 * reportCount    : number                total json files loaded
 */
const store = {
    blocksByHeight: new Map(),
    txIndex: new Map(),
    reportCount: 0,
};

// ── Loader ────────────────────────────────────────────────────────────────────

/**
 * Read all *.json files from <cwd>/out/ and populate the in-memory store.
 * Silently skips files that cannot be parsed or don't match the schema.
 *
 * @returns {Promise<void>}
 */
async function loadReports() {
    const outDir = path.join(process.cwd(), 'out');

    let entries;
    try {
        entries = await fs.readdir(outDir);
    } catch {
        // out/ directory may not exist when no analysis has been run yet
        process.stderr.write('[server] out/ directory not found — no analysis data loaded\n');
        return;
    }

    const jsonFiles = entries.filter(e => e.endsWith('.json'));

    for (const filename of jsonFiles) {
        const filePath = path.join(outDir, filename);
        try {
            const raw = await fs.readFile(filePath, 'utf-8');
            const report = JSON.parse(raw);

            if (!Array.isArray(report.blocks)) continue;

            for (const block of report.blocks) {
                const height = block.block_height;

                if (typeof height === 'number') {
                    store.blocksByHeight.set(height, block);
                }

                for (const tx of (block.transactions ?? [])) {
                    if (typeof tx.txid === 'string' && tx.txid) {
                        store.txIndex.set(tx.txid, {
                            block_hash: block.block_hash,
                            block_height: height,
                            tx,
                        });
                    }
                }
            }

            store.reportCount++;
            process.stderr.write(`[server] loaded ${filename} (${report.blocks.length} blocks)\n`);
        } catch (err) {
            process.stderr.write(`[server] skipping ${filename}: ${err.message}\n`);
        }
    }

    process.stderr.write(
        `[server] data ready — ${store.blocksByHeight.size} blocks, ` +
        `${store.txIndex.size} transactions\n`
    );
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

/**
 * Send a JSON response.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function json(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
}

// ── Route handlers ────────────────────────────────────────────────────────────

/** GET /api/blocks — sorted list of all loaded blocks with summary metadata */
function handleBlocks(res) {
    const blocks = [...store.blocksByHeight.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, b]) => ({
            block_height: b.block_height,
            block_hash: b.block_hash,
            tx_count: b.tx_count,
            flagged_transactions: b.analysis_summary?.flagged_transactions ?? 0,
        }));
    json(res, 200, { ok: true, blocks });
}

/** GET /api/health */
function handleHealth(res) {
    json(res, 200, {
        ok: true,
        reports: store.reportCount,
        blocks: store.blocksByHeight.size,
        transactions: store.txIndex.size,
    });
}

/**
 * GET /api/block/:height
 *
 * @param {import('node:http').ServerResponse} res
 * @param {string} heightParam  raw path segment, e.g. "840000"
 */
function handleBlock(res, heightParam) {
    const height = Number(heightParam);

    if (!Number.isInteger(height) || height < 0) {
        return json(res, 400, { ok: false, error: 'invalid block height' });
    }

    const block = store.blocksByHeight.get(height);
    if (!block) {
        return json(res, 404, { ok: false, error: `block at height ${height} not found` });
    }

    json(res, 200, { ok: true, block });
}

/**
 * GET /api/tx/:txid
 *
 * @param {import('node:http').ServerResponse} res
 * @param {string} txid  64-char hex txid (case-insensitive)
 */
function handleTx(res, txid) {
    // Normalise to lower-case; validate basic hex format
    const normalised = txid.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalised)) {
        return json(res, 400, { ok: false, error: 'invalid txid format' });
    }

    const entry = store.txIndex.get(normalised);
    if (!entry) {
        return json(res, 404, { ok: false, error: `transaction ${normalised} not found` });
    }

    json(res, 200, { ok: true, ...entry });
}

// ── Static file server ───────────────────────────────────────────────────────

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
};

/**
 * Serve a file from DIST_DIR, falling back to index.html for SPA routing.
 * Guards against path-traversal attacks.
 */
async function serveStatic(req, res) {
    const urlPath = (req.url ?? '/').split('?')[0];
    const relPath = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');

    // Resolve and verify the path stays inside DIST_DIR
    const fullPath = path.resolve(DIST_DIR, relPath);
    if (!fullPath.startsWith(DIST_DIR + path.sep) && fullPath !== DIST_DIR) {
        return json(res, 403, { ok: false, error: 'forbidden' });
    }

    try {
        const content = await fs.readFile(fullPath);
        const ext = path.extname(fullPath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
        res.end(content);
    } catch {
        // SPA fallback — let the React router handle unknown paths
        try {
            const index = await fs.readFile(path.join(DIST_DIR, 'index.html'));
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(index);
        } catch {
            json(res, 404, { ok: false, error: 'not found' });
        }
    }
}

// ── Request router ────────────────────────────────────────────────────────────

const ROUTE_HEALTH = /^\/api\/health\/?$/;
const ROUTE_BLOCKS = /^\/api\/blocks\/?$/;
const ROUTE_BLOCK = /^\/api\/block\/([^/]+)\/?$/;
const ROUTE_TX = /^\/api\/tx\/([^/]+)\/?$/;

/**
 * Main request handler dispatched by the HTTP server.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse}  res
 */
function onRequest(req, res) {
    const url = req.url ?? '/';

    // Strip query string for routing
    const pathname = url.split('?')[0];

    let match;

    if (req.method === 'GET' && ROUTE_HEALTH.test(pathname)) {
        return handleHealth(res);
    }

    if (req.method === 'GET' && ROUTE_BLOCKS.test(pathname)) {
        return handleBlocks(res);
    }

    if (req.method === 'GET' && (match = ROUTE_BLOCK.exec(pathname))) {
        return handleBlock(res, match[1]);
    }

    if (req.method === 'GET' && (match = ROUTE_TX.exec(pathname))) {
        return handleTx(res, match[1]);
    }

    // Fall through to static file server (serves built React app)
    return serveStatic(req, res);
}

// ── Entry point ───────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3000;

async function main() {
    await loadReports();

    const server = createServer(onRequest);

    server.listen(PORT, () => {
        // Print the single URL line to stdout as required by web.sh / the grader
        process.stdout.write(`http://127.0.0.1:${PORT}\n`);
        process.stderr.write(`[server] listening on http://localhost:${PORT}\n`);
    });

    // Graceful shutdown
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, () => {
            server.close(() => {
                process.stderr.write('[server] stopped\n');
                process.exit(0);
            });
        });
    }
}

main().catch(err => {
    console.error('[server] fatal:', err);
    process.exit(1);
});
