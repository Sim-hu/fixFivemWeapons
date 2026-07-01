import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import pkg from "./package.json" with { type: "json" };

// GitHub Pages (https://<user>.github.io/fixFivemWeapons/) 配信用に
// build 時のみリポジトリ名を base パスにする。dev サーバーは "/" のまま。
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/fixFivemWeapons/" : "/",
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
}));
