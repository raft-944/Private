import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // 本地开发时,把 /api 请求转发给 vercel dev 起的本地函数(见 README 里的本地调试说明)
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
