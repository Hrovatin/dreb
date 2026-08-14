import { resolve } from "node:path";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Builds the SolidJS sessions sidebar webview into dist/webview-sidebar with
// STABLE asset names (main.js / main.css). The extension host constructs the
// webview HTML by referencing those fixed filenames through
// `webview.asWebviewUri`, so we do not rely on hashed names or on parsing a
// generated index.html.
export default defineConfig({
	plugins: [solid()],
	root: resolve(import.meta.dirname, "src/webview/sidebar"),
	base: "./",
	build: {
		outDir: resolve(import.meta.dirname, "dist/webview-sidebar"),
		emptyOutDir: true,
		rollupOptions: {
			output: {
				entryFileNames: "main.js",
				assetFileNames: "main[extname]",
				chunkFileNames: "chunk-[name].js",
			},
		},
	},
});
