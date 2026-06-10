import { defineConfig } from 'vite';

// Minimal Vite config. Root is this package; pnpm links the @soldat/*
// workspace deps into node_modules, so no manual resolve aliases are needed.
export default defineConfig({
  root: __dirname,
  server: { open: true },
  build: { target: 'es2022' },
});
