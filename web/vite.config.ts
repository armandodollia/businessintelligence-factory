import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Local API + harness MCP server (`server.port` default). */
const API = 'http://127.0.0.1:4317';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: API },
      '/mcp': { target: API },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
