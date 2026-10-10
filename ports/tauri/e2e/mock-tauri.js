// Mock of the Tauri IPC surface for E2E tests. Installed via addInitScript BEFORE the
// app loads; the virtual filesystem comes from window.__E2E_FS and call records land in
// window.__E2E_CALLS. Mirrors src-tauri/src/comp.rs behavior, including error strings.
(function installMockTauri() {
  const calls = [];
  window.__E2E_CALLS = calls;

  function splitPath(path) {
    return path.split("/").filter((part) => part && part !== ".");
  }

  function getNode(path) {
    let node = window.__E2E_FS;
    for (const part of splitPath(path)) {
      if (node && typeof node === "object" && part in node) node = node[part];
      else return undefined;
    }
    return node;
  }

  function setNode(path, value) {
    const parts = splitPath(path);
    let node = window.__E2E_FS;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (typeof node[parts[i]] !== "object" || node[parts[i]] === null) node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;
  }

  function isCompProject(node) {
    return node && typeof node === "object" && node["manifest.json"] !== undefined;
  }

  function listProjects(root) {
    const directory = getNode(root);
    if (directory === undefined) throw `Cannot read ${root}: no such directory`;
    const projects = [];
    for (const [name, node] of Object.entries(directory)) {
      if (name.toLowerCase().endsWith(".comp") && isCompProject(node)) {
        projects.push({ name: name.replace(/\.comp$/i, ""), path: `${root.replace(/\/$/, "")}/${name}` });
      }
    }
    projects.sort((a, b) => a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1);
    return projects;
  }

  function loadProject(path) {
    const pkg = getNode(path);
    if (!pkg || typeof pkg !== "object" || !pkg["manifest.json"]) throw `Not a Compositor project: ${path}`;
    const raw = pkg["manifest.json"];
    let manifest;
    try {
      manifest = JSON.parse(typeof raw === "string" ? raw : raw.text);
    } catch (error) {
      throw `Manifest is not valid JSON: ${error.message}`;
    }
    if (manifest.version > 11 || manifest.version < 1) {
      throw `Unsupported project version ${manifest.version} (this port reads 1-11)`;
    }
    const files = new Set();
    for (const layer of manifest.layers || []) {
      if (layer.imageFile) files.add(layer.imageFile);
      if (layer.maskFile) files.add(layer.maskFile);
    }
    const images = [];
    for (const file of [...files].sort()) {
      if (file.includes("/") || file.includes("\\") || file.includes("..") || !file) {
        throw `Unsafe asset path: ${file}`;
      }
      const asset = pkg.images?.[file];
      if (asset === undefined) throw `Missing asset: ${file}`;
      const base64 = typeof asset === "string" && asset.startsWith("data:")
        ? asset.slice(5 + asset.indexOf(",") - 5).split(",").pop()
        : (typeof asset === "object" ? asset.base64 : asset);
      images.push({ file, base64 });
    }
    return { path, manifest, images };
  }

  const handlers = {
    pick_folder: ({ start }) => window.__E2E_ROOT || start || null,
    list_projects: ({ root }) => listProjects(root),
    load_project: ({ path }) => loadProject(path),
    save_manifest: ({ path, manifest }) => {
      setNode(`${path}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
      calls.push({ kind: "save_manifest", path, manifest: JSON.parse(JSON.stringify(manifest)) });
      return null;
    },
    save_project: ({ path, manifest, images }) => {
      setNode(`${path}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
      for (const asset of images || []) setNode(`${path}/images/${asset.file}`, asset.base64);
      calls.push({ kind: "save_project", path, manifest: JSON.parse(JSON.stringify(manifest)), files: (images || []).map((a) => a.file) });
      return null;
    },
    export_png: ({ fileName, base64Png }) => {
      calls.push({ kind: "export_png", fileName, base64Png });
      return `/mock-export/${fileName}`;
    },
    export_file: ({ fileName, base64, kind, quality, ppi }) => {
      // `format` carries the requested kind; `kind` stays the call tag.
      calls.push({ kind: "export_file", fileName, base64, format: kind, quality, ppi });
      return `/mock-export/${fileName}`;
    },
    import_images: () => {
      const pending = window.__E2E_IMPORT || [];
      window.__E2E_IMPORT = [];
      return pending; // [{ name, base64 }]
    },
    pick_save_path: ({ fileName }) => `/mock-export/${fileName}`,
  };

  window.__TAURI__ = {
    core: {
      invoke: (command, args = {}) => {
        const handler = handlers[command];
        if (!handler) return Promise.reject(`Unhandled command: ${command}`);
        try {
          return Promise.resolve(handler(args));
        } catch (error) {
          return Promise.reject(String(error));
        }
      },
    },
  };
})();
