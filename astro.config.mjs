import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://cateverywhere56.github.io/starter',
  build: {
    outDir: 'dist' // <-- on force le dossier de sortie
  },
});

