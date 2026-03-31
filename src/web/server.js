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
import os from 'node:os';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

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

let reportsLoaded = false;
let reportsLoadPromise = null;

function indexReport(report) {
    if (!Array.isArray(report?.blocks)) return 0;

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

    return report.blocks.length;
}

// ── Loader ────────────────────────────────────────────────────────────────────

/**
 * Read all *.json files from <cwd>/out/ and populate the in-memory store.
 * Silently skips files that cannot be parsed or don't match the schema.
 *
 * @returns {Promise<void>}
 */
async function loadReports() {
    if (reportsLoaded) return;

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

            const indexedCount = indexReport(report);
            if (indexedCount === 0) continue;

            store.reportCount++;
            process.stderr.write(`[server] loaded ${filename} (${indexedCount} blocks)\n`);
        } catch (err) {
            process.stderr.write(`[server] skipping ${filename}: ${err.message}\n`);
        }
    }

    process.stderr.write(
        `[server] data ready — ${store.blocksByHeight.size} blocks, ` +
        `${store.txIndex.size} transactions\n`
    );

    reportsLoaded = true;
}

export async function ensureReportsLoaded() {
    if (reportsLoaded) return;
    if (!reportsLoadPromise) {
        reportsLoadPromise = loadReports().finally(() => {
            reportsLoadPromise = null;
        });
    }
    await reportsLoadPromise;
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

function parseBoundary(contentType = '') {
    const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
    return (match?.[1] ?? match?.[2] ?? '').trim();
}

function splitMultipartBody(body, boundary) {
    const marker = Buffer.from(`--${boundary}`);
    const parts = [];
    let cursor = 0;

    while (cursor < body.length) {
        const start = body.indexOf(marker, cursor);
        if (start < 0) break;

        let partStart = start + marker.length;
        if (body[partStart] === 0x2d && body[partStart + 1] === 0x2d) break;
        if (body[partStart] === 0x0d && body[partStart + 1] === 0x0a) {
            partStart += 2;
        }

        const next = body.indexOf(marker, partStart);
        if (next < 0) break;

        let partEnd = next;
        if (body[partEnd - 2] === 0x0d && body[partEnd - 1] === 0x0a) {
            partEnd -= 2;
        }

        parts.push(body.subarray(partStart, partEnd));
        cursor = next;
    }

    return parts;
}

function parseMultipartFiles(contentType, body) {
    const boundary = parseBoundary(contentType);
    if (!boundary) {
        throw new Error('multipart boundary missing');
    }

    const parts = splitMultipartBody(body, boundary);
    const files = new Map();

    for (const part of parts) {
        const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
        if (headerEnd < 0) continue;

        const rawHeaders = part.subarray(0, headerEnd).toString('utf8');
        const content = part.subarray(headerEnd + 4);
        const dispo = rawHeaders
            .split('\r\n')
            .find(line => line.toLowerCase().startsWith('content-disposition:'));

        if (!dispo) continue;

        const nameMatch = /name="([^"]+)"/.exec(dispo);
        const fileMatch = /filename="([^"]*)"/.exec(dispo);
        if (!nameMatch || !fileMatch) continue;

        files.set(nameMatch[1], {
            filename: path.basename(fileMatch[1]),
            content,
        });
    }

    return files;
}

function readRequestBody(req, maxBytes = 256 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;

        req.on('data', chunk => {
            total += chunk.length;
            if (total > maxBytes) {
                reject(new Error('upload too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });

        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function runCliAnalysis(blkPath, revPath, xorPath) {
    return new Promise((resolve, reject) => {
        const args = [path.join(process.cwd(), 'src', 'cli.js'), '--block', blkPath, revPath, xorPath];
        const child = spawn(process.execPath, args, { cwd: process.cwd() });

        let stderr = '';
        let stdout = '';

        child.stdout.on('data', chunk => {
            stdout += chunk.toString();
        });

        child.stderr.on('data', chunk => {
            stderr += chunk.toString();
        });

        child.on('error', reject);
        child.on('close', code => {
            if (code === 0) {
                resolve({ stdout, stderr });
                return;
            }

            reject(new Error(`analysis failed (exit ${code})\n${stdout}\n${stderr}`.trim()));
        });
    });
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

async function handleUpload(req, res) {
    if (process.env.VERCEL === '1') {
        return json(res, 501, {
            ok: false,
            error: 'File upload analysis is disabled on Vercel. Run analysis locally and deploy generated out/*.json reports.',
        });
    }

    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
        return json(res, 400, { ok: false, error: 'expected multipart/form-data upload' });
    }

    let tempDir;
    try {
        const body = await readRequestBody(req);
        const files = parseMultipartFiles(contentType, body);

        const blk = files.get('blkFile');
        const rev = files.get('revFile');
        const xor = files.get('xorFile');

        if (!blk || !rev || !xor) {
            return json(res, 400, {
                ok: false,
                error: 'missing required files: blk.dat, rev.dat, xor.dat',
            });
        }

        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sherlock-upload-'));
        const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const blkPath = path.join(tempDir, `blk-upload-${stamp}.dat`);
        const revPath = path.join(tempDir, `rev-upload-${stamp}.dat`);
        const xorPath = path.join(tempDir, `xor-upload-${stamp}.dat`);

        await fs.writeFile(blkPath, blk.content);
        await fs.writeFile(revPath, rev.content);
        await fs.writeFile(xorPath, xor.content);

        await runCliAnalysis(blkPath, revPath, xorPath);

        const stem = path.basename(blkPath).replace(/\.dat$/i, '');
        const reportPath = path.join(process.cwd(), 'out', `${stem}.json`);
        const markdownPath = path.join(process.cwd(), 'out', `${stem}.md`);
        const rawReport = await fs.readFile(reportPath, 'utf8');
        const report = JSON.parse(rawReport);

        indexReport(report);
        store.reportCount++;

        const uploadedHeights = (report.blocks ?? [])
            .map(b => b.block_height)
            .filter(h => typeof h === 'number');

        const firstHeight = uploadedHeights[0] ?? null;
        const firstBlock = typeof firstHeight === 'number'
            ? store.blocksByHeight.get(firstHeight)
            : null;

        json(res, 200, {
            ok: true,
            block: firstBlock,
            uploaded_block_heights: uploadedHeights,
            block_count: report.block_count ?? uploadedHeights.length,
        });

        // Upload analysis should not leave temporary report artifacts on disk.
        await Promise.all([
            fs.rm(reportPath, { force: true }),
            fs.rm(markdownPath, { force: true }),
        ]).catch(() => { });
    } catch (err) {
        process.stderr.write(`[server] upload failed: ${err.message}\n`);
        json(res, 500, { ok: false, error: 'failed to analyze uploaded files' });
    } finally {
        if (tempDir) {
            await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { });
        }
    }
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
const ROUTE_UPLOAD = /^\/api\/upload\/?$/;

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

    if (req.method === 'POST' && ROUTE_UPLOAD.test(pathname)) {
        handleUpload(req, res).catch(err => {
            process.stderr.write(`[server] upload handler error: ${err.message}\n`);
            json(res, 500, { ok: false, error: 'failed to analyze uploaded files' });
        });
        return;
    }

    // Fall through to static file server (serves built React app)
    return serveStatic(req, res);
}

export function handleApiRequest(req, res) {
    const url = req.url ?? '/';
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

    if (req.method === 'POST' && ROUTE_UPLOAD.test(pathname)) {
        handleUpload(req, res).catch(err => {
            process.stderr.write(`[server] upload handler error: ${err.message}\n`);
            json(res, 500, { ok: false, error: 'failed to analyze uploaded files' });
        });
        return;
    }

    return json(res, 404, { ok: false, error: 'not found' });
}

// ── Entry point ───────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3000;

async function main() {
    await ensureReportsLoaded();

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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(err => {
        console.error('[server] fatal:', err);
        process.exit(1);
    });
}
