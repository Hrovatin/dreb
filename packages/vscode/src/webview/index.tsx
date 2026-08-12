import { render } from "solid-js/web";
import { App } from "./app.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("dreb webview: #root element missing");
render(() => <App />, root);
