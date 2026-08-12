import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

// Host and shared logic run in the default node environment. Webview component
// tests can opt into jsdom with a per-file `// @vitest-environment jsdom`
// docblock; the solid plugin + resolve aliases mirror the dashboard setup so
// such tests transform correctly.
export default defineConfig({
	plugins: [solid()],
	test: {
		globals: true,
		environment: "node",
		testTimeout: 10000,
	},
	resolve: {
		conditions: ["development", "browser"],
		alias: [{ find: /^solid-js\/web$/, replacement: "solid-js/web/dist/web.js" }],
	},
});
