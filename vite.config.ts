import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
let sha = 'dev'; try { sha = execSync('git rev-parse --short HEAD').toString().trim(); } catch { /* no git */ }
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z';
export default defineConfig({ base: './', build: { target: 'es2022' }, worker: { format: 'es' }, define: { __BUILD__: JSON.stringify(`build ${stamp} (after ${sha})`) } });
