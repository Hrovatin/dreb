import { render } from "solid-js/web";
import { SidebarApp } from "./app.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("dreb sidebar webview: #root element missing");
render(() => <SidebarApp />, root);
