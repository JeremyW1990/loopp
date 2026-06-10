import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // Object-form (not the string shorthand) so SSE responses for
      // chat.runEvents stream through unbuffered. The API already sets
      // `x-accel-buffering: no` + `cache-control: no-transform`; http-proxy
      // passes text/event-stream through chunk-by-chunk as long as we don't
      // buffer the response (no selfHandleResponse).
      "/trpc": {
        target: "http://localhost:4011",
        changeOrigin: true,
      },
    },
  },
});
