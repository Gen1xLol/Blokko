import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  base: '/Blokko/',
  plugins: [svelte()],
  worker: { format: 'es' },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/@material/web/')) return 'material-web';
          if (id.includes('/node_modules/chart.js/')) return 'chart';
        },
      },
    },
  },
})
