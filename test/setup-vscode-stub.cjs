const Module = require("module");
const path = require("path");
const fs = require("fs/promises");

const configuration = new Map();
const outputLines = [];

class Disposable {
  constructor(fn) {
    this._fn = fn;
  }

  dispose() {
    if (this._fn) {
      this._fn();
      this._fn = null;
    }
  }
}

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return new Disposable(() => this.listeners.delete(listener));
    };
  }

  fire(value) {
    for (const listener of this.listeners) {
      listener(value);
    }
  }

  dispose() {
    this.listeners.clear();
  }
}

class ThemeIcon {
  constructor(id) {
    this.id = id;
  }
}

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class OutputChannel {
  appendLine(value) {
    outputLines.push(String(value));
  }

  show() {}

  clear() {
    outputLines.length = 0;
  }

  dispose() {}
}

const vscodeStub = {
  Disposable,
  EventEmitter,
  ThemeIcon,
  TreeItem,
  TreeItemCollapsibleState: {
    None: 0,
  },
  FileType: {
    File: 1,
    Directory: 2,
  },
  Uri: {
    file(fsPath) {
      return {
        scheme: "file",
        fsPath: path.resolve(fsPath),
      };
    },
  },
  env: {
    language: "en",
  },
  workspace: {
    name: "test-workspace",
    workspaceFolders: [],
    getConfiguration(section) {
      return {
        get(key, fallback) {
          return configuration.has(`${section}.${key}`) ? configuration.get(`${section}.${key}`) : fallback;
        },
      };
    },
    async openTextDocument(uri) {
      const content = await fs.readFile(uri.fsPath, "utf8");
      return {
        getText() {
          return content;
        },
        languageId: languageIdForPath(uri.fsPath),
      };
    },
    fs: {
      async stat(uri) {
        const result = await fs.stat(uri.fsPath);
        return {
          type: result.isDirectory() ? 2 : 1,
          ctime: result.ctimeMs,
          mtime: result.mtimeMs,
          size: result.size,
        };
      },
      async readDirectory(uri) {
        const entries = await fs.readdir(uri.fsPath, { withFileTypes: true });
        return entries.map((entry) => [
          entry.name,
          entry.isDirectory() ? 2 : entry.isFile() ? 1 : 0,
        ]);
      },
    },
  },
  window: {
    createOutputChannel() {
      return new OutputChannel();
    },
    async showWarningMessage() {
      return undefined;
    },
    async showInformationMessage() {
      return undefined;
    },
  },
  __setConfig(values) {
    configuration.clear();
    for (const [key, value] of Object.entries(values || {})) {
      configuration.set(key, value);
    }
  },
  __setWorkspaceFolders(folders) {
    vscodeStub.workspace.workspaceFolders = folders;
  },
  __setLanguage(language) {
    vscodeStub.env.language = language;
  },
  __getOutputLines() {
    return [...outputLines];
  },
  __clearOutputLines() {
    outputLines.length = 0;
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") {
    return vscodeStub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

function languageIdForPath(fsPath) {
  const extension = path.extname(fsPath).toLowerCase();
  switch (extension) {
    case ".ts":
      return "typescript";
    case ".tsx":
      return "typescriptreact";
    case ".js":
      return "javascript";
    case ".jsx":
      return "javascriptreact";
    case ".json":
      return "json";
    case ".md":
      return "markdown";
    default:
      return "plaintext";
  }
}
