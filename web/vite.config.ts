import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const previewOrigin=process.env.PICKMEUP_PREVIEW_ORIGIN;
const previewHost=previewOrigin&&URL.canParse(previewOrigin)?new URL(previewOrigin).hostname:undefined;
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': { target: 'http://127.0.0.1:4310', rewrite: path => path.replace(/^\/api/, '') } } },
  // Temporary phone demonstration: serve the built app and only the assigned host.
  preview: {host:'127.0.0.1',port:5173,strictPort:true,allowedHosts:previewHost?[previewHost]:[]}
});
