import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    watch: {
      // /mnt/e is a Windows mount — inotify doesn't fire, so poll.
      usePolling: true,
      interval: 300,
    },
  },
});
