import { ensureReportsLoaded, handleApiRequest } from '../src/web/server.js';

export default async function handler(req, res) {
    await ensureReportsLoaded();
    return handleApiRequest(req, res);
}
