import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

// The splash window shares this same entry point. Don't mount the
// titlebar there — it's a small undecorated popup, not the main window.
const isSplashWindow = (() => {
  try {
    return getCurrentWindow().label === "splash";
  } catch {
    return new URLSearchParams(window.location.search).get("window") === "splash";
  }
})();

// Render titlebar (outside scaled root)
if (!isSplashWindow) {
  const titlebarEl = document.getElementById("titlebar")!;
  const titlebarRoot = ReactDOM.createRoot(titlebarEl);
  titlebarRoot.render(
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-title" data-tauri-drag-region>arca0.1.6</div>
      <div className="window-controls">
        <button className="window-btn minimize" onClick={() => invoke("minimize_window")} title="Minimize">
          <svg width="12" height="1" viewBox="0 0 12 1"><path d="M0 0h12v1H0z" fill="currentColor"/></svg>
        </button>
        <button className="window-btn maximize" onClick={() => invoke("toggle_maximize")} title="Maximize">
          <svg width="12" height="12" viewBox="0 0 12 12"><path d="M0 0h12v12H0V0zm1 1v10h10V1H1z" fill="currentColor"/></svg>
        </button>
        <button className="window-btn close" onClick={() => invoke("close_window")} title="Close">
          <svg width="12" height="12" viewBox="0 0 12 12"><path d="M1 0L0 1l5 5-5 5 1 1 5-5 5 5 1-1-5-5 5-5-1-1-5 5-5-5z" fill="currentColor"/></svg>
        </button>
      </div>
    </div>
  );
}

// Render main app (with uiScale)
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);