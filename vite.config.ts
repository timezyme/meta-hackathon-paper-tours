import { defineConfig } from "vite"

export default defineConfig({
  root: "src/app",
  base: "/app/",
  publicDir: false,
  envDir: false,
  build: {
    outDir: "../mastra/public/app",
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
})
