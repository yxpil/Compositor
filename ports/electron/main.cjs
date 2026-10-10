// Electron main process: window shell, the app:// static server for the
// frontend's ES modules, and the IPC bridge to the backend. The command
// surface mirrors the Tauri port's invoke handler (src-tauri/src/lib.rs).
// CommonJS: this Electron build crashes on ESM main processes.

const { app, BrowserWindow, dialog, ipcMain, protocol, net, shell } = require("electron");
const path = require("node:path");
const { createBackend } = require("./backend.cjs");

const __dirname_fixed = __dirname;
const SRC_DIR = path.join(__dirname_fixed, "src");

// A privileged scheme so the renderer can fetch its module tree with CORS.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

// Native dialogs wired into the backend. Filter lists and titles match the
// Tauri port's dialog usage in comp.rs.
const dialogs = {
  async pickFolder(start) {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: "Choose a folder containing .comp projects",
      defaultPath: start || undefined,
      properties: ["openDirectory"],
    });
    if (canceled || filePaths.length === 0) return null;
    return filePaths[0];
  },

  async saveFile(fileName, kind) {
    const extensions = kind === "jpeg" ? ["jpg", "jpeg"] : ["png"];
    const filters = [{ name: kind === "jpeg" ? "JPEG image" : "PNG image", extensions }];
    const { canceled, filePath } = await dialog.showSaveDialog({
      filters,
      defaultPath: fileName ? path.join(app.getPath("documents"), fileName) : undefined,
    });
    if (canceled || !filePath) return null;
    return filePath;
  },

  async savePackage(fileName) {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: "Save Compositor Project",
      filters: [{ name: "Compositor project", extensions: ["comp"] }],
      defaultPath: fileName ? path.join(app.getPath("documents"), fileName) : undefined,
    });
    if (canceled || !filePath) return null;
    return filePath;
  },

  async pickFiles() {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      filters: [
        {
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "tif", "tiff", "heic", "heif", "webp", "bmp", "gif"],
        },
      ],
      properties: ["openFile", "multiSelections"],
    });
    if (canceled) return [];
    return filePaths;
  },
};

const backend = createBackend(dialogs);

ipcMain.handle("compositor:invoke", async (_event, command, args) => backend.invoke(command, args ?? {}));

function createWindow() {
  const win = new BrowserWindow({
    title: "Compositor Port",
    width: 1360,
    height: 860,
    minWidth: 940,
    minHeight: 600,
    webPreferences: {
      // Sandbox requires a CommonJS preload; .cjs keeps it so regardless of
      // the package.json "type".
      preload: path.join(__dirname_fixed, "preload.cjs"),
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  win.loadURL("app://bundle/index.html");
}

app.whenReady().then(() => {
  // Serve the frontend directory under app://bundle/. ES module imports work
  // here where plain file:// URLs would be CORS-blocked by Chromium.
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    if (url.host !== "bundle") {
      return new Response("Not found", { status: 404 });
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    const resolved = path.normalize(path.join(SRC_DIR, relative));
    if (!resolved.startsWith(SRC_DIR)) {
      return new Response("Not found", { status: 404 });
    }
    return net.fetch(require("node:url").pathToFileURL(resolved).toString());
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
