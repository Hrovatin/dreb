import { render } from "solid-js/web";
import { App } from "./app.js";
import "./styles.css";
// KaTeX stylesheet + fonts for rendered LaTeX math (see webview/markdown.ts).
// vite bundles this into main.css and emits the fonts as hashed assets under
// dist/webview/assets (see vite.config.mts assetFileNames).
import "katex/dist/katex.min.css";

const root = document.getElementById("root");
if (!root) throw new Error("dreb webview: #root element missing");
render(() => <App />, root);
