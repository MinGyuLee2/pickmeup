import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
export default defineConfig({root:fileURLToPath(new URL('../web',import.meta.url)),plugins:[react()],base:'/filming/',build:{outDir:fileURLToPath(new URL('../.local/filming-demo/web',import.meta.url)),emptyOutDir:true,rolldownOptions:{input:fileURLToPath(new URL('../web/filming.html',import.meta.url))}}});
