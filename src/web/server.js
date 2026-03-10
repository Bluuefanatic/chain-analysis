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
        console.warn('[server] out/ directory not found — no analysis data loaded');
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
            console.info(`[server] loaded ${filename} (${report.blocks.length} blocks)`);
        } catch (err) {
            console.warn(`[server] skipping ${filename}: ${err.message}`);
        }
    }

    console.info(
        `[server] data ready — ${store.blocksByHeight.size} blocks, ` +
        `${store.txIndex.size} transactions`
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

// ── Request router ────────────────────────────────────────────────────────────

const ROUTE_HEALTH = /^\/api\/health\/?$/;
const ROUTE_BLOCK  = /^\/api\/block\/([^/]+)\/?$/;
const ROUTE_TX     = /^\/api\/tx\/([^/]+)\/?$/;

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

    if (req.method === 'GET' && (match = ROUTE_BLOCK.exec(pathname))) {
        return handleBlock(res, match[1]);
    }

    if (req.method === 'GET' && (match = ROUTE_TX.exec(pathname))) {
        return handleTx(res, match[1]);
    }

    json(res, 404, { ok: false, error: 'not found' });
}

// ── Entry point ───────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3000;

async function main() {
    await loadReports();

    const server = createServer(onRequest);

    server.listen(PORT, () => {
        console.info(`[server] listening on http://localhost:${PORT}`);
    });

    // Graceful shutdown
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, () => {
            server.close(() => {
                console.info('[server] stopped');
                process.exit(0);
            });
        });
    }
}

main().catch(err => {
    console.error('[server] fatal:', err);
    process.exit(1);
});
