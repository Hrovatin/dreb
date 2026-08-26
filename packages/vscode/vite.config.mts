import { resolve } from "node:path";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Builds the SolidJS webview into dist/webview with STABLE asset names
// (main.js / main.css). The extension host constructs the webview HTML by
// referencing those fixed filenames through `webview.asWebviewUri`, so we do
// not rely on hashed names or on parsing a generated index.html.
export default defineConfig({
	plugins: [solid()],
	root: resolve(import.meta.dirname, "src/webview"),
	base: "./",
	build: {
		outDir: resolve(import.meta.dirname, "dist/webview"),
		emptyOutDir: true,
		rollupOptions: {
			output: {
				entryFileNames: "main.js",
				// Keep the single stylesheet at the stable `main.css` the host HTML
				// links, but give every other asset (KaTeX's ~60 font files) a
				// distinct hashed name — a flat `main[extname]` would collapse them
				// all onto one file, breaking font loading (tofu/missing glyphs).
				assetFileNames: (assetInfo) => {
					const name =
						(assetInfo as { names?: string[]; name?: string }).names?.[0] ??
						(assetInfo as { name?: string }).name ??
						"";
					if (name.endsWith(".css")) return "main.css";
					return "assets/[name]-[hash][extname]";
				},
				chunkFileNames: "chunk-[name].js",
			},
		},
	},
});
