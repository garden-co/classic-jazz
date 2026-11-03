import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  // Keep each bundled adapter with its own Kysely version in the hoisted workspace.
  ssr: { noExternal: ['kysely'] },
});
