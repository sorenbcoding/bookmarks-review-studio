// Minimal `vscode` API mock for controller tests: real file system, recorded UI calls.
const fsp = require('fs/promises');
const path = require('path');

class Uri {
  constructor(fsPath) {
    this.fsPath = fsPath;
    this.scheme = 'file';
  }
  static file(p) {
    return new Uri(path.resolve(p));
  }
  static joinPath(base, ...segments) {
    return new Uri(path.join(base.fsPath, ...segments));
  }
  toString() {
    return `file:///${this.fsPath.replace(/\\/g, '/')}`;
  }
}

class FileSystemError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const mapErrors = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (err) {
    if (err.code === 'ENOENT') throw new FileSystemError('FileNotFound');
    throw err;
  }
};

const FileType = { File: 1, Directory: 2 };
const noopDisposable = { dispose() {} };
const watcher = () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} });

// Recorded calls and canned answers; tests reset these.
const mock = {
  workspaceFolders: [],
  warningAnswer: undefined,
  messages: [],
  opened: [],
  providers: new Map(),
  settings: {}, // 'section.key' -> value (user settings)
  settingsReadOnly: false, // true: update() throws, like a host that can't save settings
};

module.exports = {
  mock,
  Uri,
  FileType,
  FileSystemError,
  RelativePattern: class {
    constructor(base, pattern) {
      Object.assign(this, { base, pattern });
    }
  },
  Disposable: { from: () => noopDisposable },
  workspace: {
    get workspaceFolders() {
      return mock.workspaceFolders;
    },
    fs: {
      readFile: mapErrors((u) => fsp.readFile(u.fsPath)),
      writeFile: mapErrors((u, data) => fsp.writeFile(u.fsPath, data)),
      createDirectory: (u) => fsp.mkdir(u.fsPath, { recursive: true }),
      readDirectory: mapErrors(async (u) => (await fsp.readdir(u.fsPath, { withFileTypes: true })).map((d) => [d.name, d.isDirectory() ? 2 : 1])),
      delete: mapErrors((u, opts) => fsp.rm(u.fsPath, { recursive: Boolean(opts?.recursive) })),
      stat: mapErrors((u) => fsp.stat(u.fsPath)),
    },
    findFiles: async () => [],
    getConfiguration: (section) => ({
      get: (key, fallback) => mock.settings[`${section}.${key}`] ?? fallback,
      update: async (key, value) => {
        if (mock.settingsReadOnly) throw new Error('Unable to write to User Settings');
        mock.settings[`${section}.${key}`] = value;
      },
    }),
    onDidChangeConfiguration: () => noopDisposable,
    createFileSystemWatcher: watcher,
  },
  window: {
    activeTextEditor: undefined,
    onDidChangeActiveTextEditor: () => noopDisposable,
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    registerWebviewViewProvider: (id, provider) => {
      mock.providers.set(id, provider);
      return noopDisposable;
    },
    showInformationMessage: async (m) => void mock.messages.push(['info', m]),
    showErrorMessage: async (m) => void mock.messages.push(['error', m]),
    showWarningMessage: async (m) => {
      mock.messages.push(['warning', m]);
      return mock.warningAnswer;
    },
  },
  env: {
    openExternal: async (uri) => {
      mock.opened.push(uri);
      return true;
    },
  },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  commands: { executeCommand: async () => undefined },
};
