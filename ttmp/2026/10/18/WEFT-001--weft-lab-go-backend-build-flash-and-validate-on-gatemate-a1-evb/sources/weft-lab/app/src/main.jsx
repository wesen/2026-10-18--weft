import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App.jsx";
import { lab } from "./ui/lab.js";

async function connectClaude() {
  // capabilities light up later, or resolve null when this view cannot run them
  let use = window.claude?.use;
  for (let i = 0; !use && i < 30; i++) { await new Promise((r) => setTimeout(r, 100)); use = window.claude?.use; }
  if (!use) { lab.platformReady = true; lab.bump("platform", "agent"); return; }
  try { lab.sample = await use("sample"); } catch { lab.sample = null; }
  try { lab.downloads = await use("downloads"); } catch { lab.downloads = null; }
  lab.platformReady = true;
  lab.bump("platform", "agent");
}

async function main() {
  const root = createRoot(document.getElementById("root"));
  root.render(<App />);
  connectClaude();
  try {
    await new Promise((r) => setTimeout(r, 0));
    await lab.start();
  } catch (e) {
    console.error(e);
    lab.error = e?.message || String(e);
    lab.bump("ready");
  }
}
main();
