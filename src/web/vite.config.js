import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    // Vite root is src/web/ — index.html lives here
    root: __dirname,

    build: {
        outDir: path.join(__dirname, 'dist'),
        emptyOutDir: true,
    },

    // In dev mode, proxy /api/* to the Node API server
    server: {
        port: 5174,
        proxy: {
            '/api': {
                target: `http://localhost:${process.env.PORT || 3000}`,
                changeOrigin: true,
            },
        },
    },

    plugins: [react()],
});
