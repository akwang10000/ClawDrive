const Module = require("module");
const path = require("path");
const fs = require("fs/promises");

const configuration = new Map();
const outputLines = [];
const registeredExtensions = new Map();
const registeredCommands = new Map();
let openExternalHandler = async () => true;

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
  StatusBarAlignment: {
    Left: 1,
    Right: 2,
  },
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
        toString() {
          return `file://${this.fsPath.replace(/\\/g, "/")}`;
        },
      };
    },
    parse(value) {
      const parsed = new URL(value);
      return {
        scheme: parsed.protocol.replace(/:$/, ""),
        authority: parsed.host,
        path: parsed.pathname,
        query: parsed.search.replace(/^\?/, ""),
        fsPath: parsed.pathname,
        toString() {
          return value;
        },
      };
    },
  },
  commands: {
    registerCommand(commandId, handler) {
      registeredCommands.set(commandId, handler);
      return new Disposable(() => registeredCommands.delete(commandId));
    },
    async executeCommand(commandId, ...args) {
      const handler = registeredCommands.get(commandId);
      if (!handler) {
        throw new Error(`Command not registered: ${commandId}`);
      }
      return await handler(...args);
    },
  },
  env: {
    language: "en",
    async openExternal(uri) {
      return await openExternalHandler(uri);
    },
  },
  extensions: {
    getExtension(id) {
      return registeredExtensions.get(id);
    },
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
    onDidChangeConfiguration() {
      return new Disposable();
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
    createStatusBarItem() {
      return {
        text: "",
        tooltip: "",
        command: undefined,
        show() {},
        hide() {},
        dispose() {},
      };
    },
    registerTreeDataProvider() {
      return new Disposable();
    },
    async showWarningMessage() {
      return undefined;
    },
    async showInformationMessage() {
      return undefined;
    },
    async showErrorMessage() {
      return undefined;
    },
    async showInputBox() {
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
  __setOpenExternal(handler) {
    openExternalHandler = typeof handler === "function" ? handler : async () => true;
  },
  __setExtensions(entries) {
    registeredExtensions.clear();
    for (const [id, value] of Object.entries(entries || {})) {
      registeredExtensions.set(id, value);
    }
  },
  __getRegisteredCommands() {
    return [...registeredCommands.keys()];
  },
  __clearRegisteredCommands() {
    registeredCommands.clear();
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
