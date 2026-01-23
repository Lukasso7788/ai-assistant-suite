import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@assistant/ui": path.resolve(__dirname, "../../packages/assistant-ui/src"),
      "@assistant/core": path.resolve(__dirname, "../../packages/assistant-core/src")
    }
  },
  server: {
    fs: {
      // разрешаем Vite читать файлы выше папки приложения (монорепо)
      allow: ["..", "../.."]
    }
  }
});
