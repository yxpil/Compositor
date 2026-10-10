// Renderer bridge (CommonJS: sandboxed preloads are always CJS). The frontend
// speaks the same invoke surface as the Tauri port, exposed here under a
// host-neutral name; only app.js and io.js touch it (window.__COMPOSITOR__.core),
// one line each.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__COMPOSITOR__", {
  core: {
    invoke: (command, args = {}) => ipcRenderer.invoke("compositor:invoke", command, args),
  },
});
