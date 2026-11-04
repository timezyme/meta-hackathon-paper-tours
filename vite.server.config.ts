import { defineConfig } from "vite"

export default defineConfig({
  publicDir: false,
  envDir: false,
  build: {
    ssr: "src/server/main.ts",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: { output: { entryFileNames: "server.mjs" } },
  },
})
