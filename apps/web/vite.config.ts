import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Busy-machine overrides: WEB_PORT moves the dev server, VITE_API_PROXY
// repoints the /trpc proxy at a non-default API port. Both default to the
// values this repo ships with, so an unset env means no behavior change.
const WEB_PORT = Number(process.env.WEB_PORT) || 5173;
const API_PROXY = process.env.VITE_API_PROXY || "http://localhost:4011";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: WEB_PORT,
    proxy: {
      // Object-form (not the string shorthand) so SSE responses for
      // chat.runEvents stream through unbuffered. The API already sets
      // `x-accel-buffering: no` + `cache-control: no-transform`; http-proxy
      // passes text/event-stream through chunk-by-chunk as long as we don't
      // buffer the response (no selfHandleResponse).
      "/trpc": {
        target: API_PROXY,
        changeOrigin: true,
      },
    },
  },
});
