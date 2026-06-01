import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const rawEnv = loadEnv(mode, process.cwd(), "");
  const isProduction = mode === "production";
  const isGitHubPages = process.env.GITHUB_REPOSITORY?.toLowerCase() === "yacobolo/quackalog";

  return {
    base: isProduction && isGitHubPages ? "/quackalog/" : "/",
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
      },
    },
    define: {
      "import.meta.env.VITE_QUACK_URI": JSON.stringify(
        rawEnv.VITE_QUACK_URI || process.env.VITE_QUACK_URI || rawEnv.uri || process.env.uri || "",
      ),
      "import.meta.env.VITE_QUACK_TOKEN": JSON.stringify(
        isProduction ? "" : rawEnv.VITE_QUACK_TOKEN || process.env.VITE_QUACK_TOKEN || rawEnv.token || process.env.token || "",
      ),
    },
  };
});
