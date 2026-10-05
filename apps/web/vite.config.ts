import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

const apiTarget = process.env.VITE_API_TARGET ?? "http://127.0.0.1:8080"
const developmentPort = Number(process.env.VITE_DEV_PORT ?? 5173)

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: process.env.VITE_DEV_HOST ?? "127.0.0.1",
    port: developmentPort,
    proxy: {
      "/api": apiTarget,
      "/health": apiTarget,
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: "jsdom",
    // Bound concurrency for full-app jsdom tests.
    maxWorkers: 2,
    testTimeout: 15_000,
    setupFiles: "./src/test/setup.ts",
    clearMocks: true,
    restoreMocks: true,
    environmentOptions: {
      jsdom: {
        url: "http://localhost/",
      },
    },
  },
})
