const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('koda');
  return {
    workerUrl: String(cfg.get('workerUrl') || '').replace(/\/+$/, ''),
    model: String(cfg.get('model') || 'auto'),
    temperature: Number(cfg.get('temperature') !== undefined ? cfg.get('temperature') : 0.6),
    autoApply: !!cfg.get('autoApply'),
    maxContextFiles: Number(cfg.get('maxContextFiles') || 6),
    webSearchByDefault: !!cfg.get('webSearchByDefault'),
    showSources: cfg.get('showSources') !== false,
    confirmDelete: cfg.get('confirmDelete') !== false
  };
}

function getPublicConfig() {
  const c = getConfig();
  return {
    model: c.model,
    temperature: c.temperature,
    autoApply: c.autoApply,
    maxContextFiles: c.maxContextFiles,
    webSearchByDefault: c.webSearchByDefault,
    showSources: c.showSources,
    confirmDelete: c.confirmDelete,
    workerUrl: c.workerUrl
  };
}

function relPath(abs) {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) return abs;
  return path.relative(folders[0].uri.fsPath, abs).split(path.sep).join('/');
}

function absPath(rel) {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) throw new Error('No workspace folder');
  return path.join(folders[0].uri.fsPath, rel);
}

async function callWorker(payload) {
  const { workerUrl } = getConfig();
  if (!workerUrl) throw new Error('Set koda.workerUrl in settings.');
  const res = await fetch(workerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    let detail = 'Worker returned ' + res.status;
    try {
      const err = await res.json();
      if (err.error) detail = err.error;
      if (err.detail) detail += ' - ' + String(err.detail).slice(0, 250);
    } catch (_) {}
    throw new Error(detail);
  }
  return res.json();
}

async function gatherContext(opts) {
  opts = opts || {};
  const cfg = getConfig();
  const editor = vscode.window.activeTextEditor;
  const ctx = { activeFile: null, selection: null, openFiles: [], mentionedFiles: [], problems: null, git: null };

  if (editor && !editor.document.isUntitled) {
    const doc = editor.document;
    ctx.activeFile = {
      path: relPath(doc.uri.fsPath),
      language: doc.languageId,
      content: doc.getText().slice(0, 20000)
    };
    if (!editor.selection.isEmpty) {
      ctx.selection = {
        path: relPath(doc.uri.fsPath),
        language: doc.languageId,
        startLine: editor.selection.start.line + 1,
        endLine: editor.selection.end.line + 1,
        text: doc.getText(editor.selection)
      };
    }
  }

  if (opts.includeOpenFiles !== false) {
    const seen = new Set();
    if (ctx.activeFile) seen.add(ctx.activeFile.path);
    for (const tab of vscode.window.tabGroups.all.flatMap(g => g.tabs)) {
      if (ctx.openFiles.length >= cfg.maxContextFiles) break;
      const input = tab.input;
      if (input && input.uri && input.uri.scheme === 'file') {
        const rp = relPath(input.uri.fsPath);
        if (seen.has(rp)) continue;
        seen.add(rp);
        try {
          const doc = await vscode.workspace.openTextDocument(input.uri);
          const text = doc.getText();
          if (text.length < 15000) {
            ctx.openFiles.push({ path: rp, language: doc.languageId, content: text });
          }
        } catch (_) {}
      }
    }
  }

  if (Array.isArray(opts.mentions) && opts.mentions.length) {
    for (const m of opts.mentions) {
      if (m === 'problems') {
        try {
          const all = vscode.languages.getDiagnostics();
          const items = [];
          for (const [uri, diags] of all) {
            for (const d of diags) {
              if (items.length >= 50) break;
              items.push({
                file: relPath(uri.fsPath),
                line: d.range.start.line + 1,
                severity: ['Error', 'Warning', 'Info', 'Hint'][d.severity] || 'Info',
                message: String(d.message).slice(0, 240)
              });
            }
            if (items.length >= 50) break;
          }
          ctx.problems = items;
        } catch (_) {}
        continue;
      }
      if (m === 'git') {
        try {
          const gitExt = vscode.extensions.getExtension('vscode.git');
          if (gitExt) {
            const git = gitExt.exports.getAPI(1);
            if (git && git.repositories && git.repositories.length) {
              const repo = git.repositories[0];
              ctx.git = {
                branch: (repo.state.HEAD && repo.state.HEAD.name) || 'unknown',
                changes: (repo.state.workingTreeChanges || []).slice(0, 30).map(c => ({
                  file: relPath(c.uri.fsPath),
                  status: String(c.status)
                }))
              };
            }
          }
        } catch (_) {}
        continue;
      }
      try {
        const uri = vscode.Uri.file(absPath(m));
        const doc = await vscode.workspace.openTextDocument(uri);
        ctx.mentionedFiles.push({
          path: m,
          language: doc.languageId,
          content: doc.getText().slice(0, 20000)
        });
      } catch (_) {}
    }
  }
  return ctx;
}

function expandSlash(message, ctx) {
  const trimmed = String(message || '').trim();
  const m = trimmed.match(/^\/(\w+)\s*([\s\S]*)$/);
  if (!m) return message;
  const cmd = m[1].toLowerCase();
  const rest = m[2].trim();

  const fileCtx = ctx.selection
    ? '\n\nSelected code (' + ctx.selection.path + '):\n```' + (ctx.selection.language || '') + '\n' + ctx.selection.text + '\n```'
    : (ctx.activeFile
        ? '\n\nCurrent file (' + ctx.activeFile.path + '):\n```' + (ctx.activeFile.language || '') + '\n' + ctx.activeFile.content.slice(0, 8000) + '\n```'
        : '');

  switch (cmd) {
    case 'explain':
      return 'Explain this code step by step using your 4-step method (Problem -> Cause -> Solution -> Practice).' + fileCtx + (rest ? '\n\nFocus: ' + rest : '');
    case 'fix':
      return 'Find and fix bugs in this code. Explain what is wrong and why.' + fileCtx + '\n\nBug description: ' + (rest || 'Help me identify the issues.');
    case 'test':
      return 'Write unit tests for this code using the standard testing framework for the language.' + fileCtx + '\n\nSpecific request: ' + (rest || 'Cover the main paths and edge cases.');
    case 'doc':
      return 'Add documentation to this code. Use JSDoc, docstrings, or inline comments as appropriate.' + fileCtx + (rest ? '\n\nNotes: ' + rest : '');
    case 'refactor':
      return 'Refactor this code for readability and maintainability without changing behavior.' + fileCtx + '\n\nGoals: ' + (rest || 'improve clarity');
    case 'optimize':
      return 'Optimize this code for performance. Explain the trade-offs.' + fileCtx + '\n\nTarget: ' + (rest || 'general performance');
    default:
      return message;
  }
}

function parseEdits(text) {
  const edits = [];
  const re = /```(\w+)?[ \t]+path=([^\s`]+)[ \t]*\n([\s\S]*?)```/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    edits.push({
      language: match[1] || 'text',
      path: match[2].trim(),
      content: match[3].replace(/\n$/, '')
    });
  }
  return edits;
}

async function applyEdit(edit) {
  const uri = vscode.Uri.file(absPath(edit.path));
  let doc;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch (_) {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(edit.content, 'utf8'));
    return { created: true, path: edit.path };
  }
  const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
  const we = new vscode.WorkspaceEdit();
  we.replace(uri, fullRange, edit.content);
  await vscode.workspace.applyEdit(we);
  return { updated: true, path: edit.path };
}

class KodaDiffProvider {
  constructor() { this.store = new Map(); }
  set(key, content) { this.store.set(key, content); }
  provideTextDocumentContent(uri) {
    const key = uri.query || uri.path.replace(/^\//, '');
    return this.store.get(key) || '';
  }
}

let diffProvider = null;

async function showDiffPreview(originalPath, newContent, title) {
  const key = 'd-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  diffProvider.set(key, newContent);
  const originalUri = vscode.Uri.file(absPath(originalPath));
  const modifiedUri = vscode.Uri.parse('koda-diff:' + originalPath + '? ' + key);
  await vscode.commands.executeCommand('vscode.diff', originalUri, modifiedUri, title || 'KODA: ' + originalPath);
}

function makeTitle(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  return t.length > 42 ? t.slice(0, 42) + '\u2026' : (t || 'New Chat');
}

class KodaChatView {
  constructor(extensionUri, context) {
    this.extensionUri = extensionUri;
    this.context = context;
    this.view = null;
    this.conversations = [];
    this.currentConvId = null;
    this.currentAbort = null;
    this._load();
  }

  _load() {
    try {
      const saved = this.context.workspaceState.get('koda.conversations', []);
      this.conversations = Array.isArray(saved) ? saved : [];
      this.currentConvId = this.context.workspaceState.get('koda.currentConvId', null);
    } catch (_) {
      this.conversations = [];
      this.currentConvId = null;
    }
    if (!this.currentConvId || !this.conversations.find(c => c.id === this.currentConvId)) {
      this._newConversation(false);
    }
  }

  _save() {
    try {
      this.context.workspaceState.update('koda.conversations', this.conversations);
      this.context.workspaceState.update('koda.currentConvId', this.currentConvId);
    } catch (_) {}
  }

  _newConversation(notify) {
    const id = 'c-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const conv = { id, title: 'New Chat', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    this.conversations.unshift(conv);
    this.currentConvId = id;
    this._save();
    if (notify && this.view) {
      this._pushList();
      this.view.webview.postMessage({ type: 'loadConversation', id, messages: [] });
    }
    return conv;
  }

  currentConv() {
    return this.conversations.find(c => c.id === this.currentConvId) || null;
  }

  _pushList() {
    if (!this.view) return;
    this.view.webview.postMessage({
      type: 'conversationsList',
      conversations: this.conversations.map(c => ({ id: c.id, title: c.title, updatedAt: c.updatedAt })),
      currentId: this.currentConvId
    });
  }

  pushConfig() {
    if (!this.view) return;
    this.view.webview.postMessage({ type: 'config', config: getPublicConfig() });
  }

  newChat() { this._newConversation(true); }

  selectConversation(id) {
    const c = this.conversations.find(c => c.id === id);
    if (!c) return;
    this.currentConvId = id;
    this._save();
    if (this.view) {
      this.view.webview.postMessage({ type: 'loadConversation', id, messages: c.messages || [] });
      this._pushList();
    }
  }

  deleteConversation(id) {
    this.conversations = this.conversations.filter(c => c.id !== id);
    if (!this.conversations.length) {
      this._newConversation(false);
    } else if (this.currentConvId === id) {
      this.currentConvId = this.conversations[0].id;
    }
    this._save();
    if (this.view) {
      this.view.webview.postMessage({ type: 'loadConversation', id: this.currentConvId, messages: this.currentConv().messages || [] });
      this._pushList();
    }
  }

  clearCurrent() {
    const c = this.currentConv();
    if (c) { c.messages = []; c.updatedAt = Date.now(); this._save(); }
    if (this.view) this.view.webview.postMessage({ type: 'loadConversation', id: this.currentConvId, messages: [] });
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    const cfg = getConfig();
    const nonce = crypto.randomBytes(16).toString('base64');
    const csp = [
      "default-src 'none'",
      "style-src " + webviewView.webview.cspSource + " 'unsafe-inline'",
      "script-src 'nonce-" + nonce + "' https://cdnjs.cloudflare.com",
      "font-src " + webviewView.webview.cspSource,
      "img-src " + webviewView.webview.cspSource + " https: data:"
    ].join('; ');

    const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'chat.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html
      .replace(/\{\{CSP\}\}/g, csp)
      .replace(/\{\{NONCE\}\}/g, nonce)
      .replace(/\{\{WEBSEARCH_DEFAULT\}\}/g, cfg.webSearchByDefault ? 'true' : 'false')
      .replace(/\{\{CONFIG_JSON\}\}/g, JSON.stringify(getPublicConfig()).replace(/</g, '\\u003c'));
    webviewView.webview.html = html;

    webviewView.webview.onDidReceiveMessage(async msg => {
      if (!msg || !msg.type) return;
      if (msg.type === 'ready') {
        const conv = this.currentConv();
        webviewView.webview.postMessage({ type: 'loadConversation', id: this.currentConvId, messages: (conv && conv.messages) || [] });
        this._pushList();
        this.pushConfig();
      } else if (msg.type === 'ask') {
        await this.handleAsk(msg);
      } else if (msg.type === 'stop') {
        if (this.currentAbort) { try { this.currentAbort.abort(); } catch (_) {} }
      } else if (msg.type === 'newChat') {
        this.newChat();
      } else if (msg.type === 'selectConversation') {
        this.selectConversation(msg.id);
      } else if (msg.type === 'deleteConversation') {
        this.deleteConversation(msg.id);
      } else if (msg.type === 'clearCurrent') {
        this.clearCurrent();
      } else if (msg.type === 'applyEdit') {
        await this.handleApply(msg);
      } else if (msg.type === 'applyAll') {
        for (const e of msg.edits || []) await this.handleApply({ edit: e, silent: true });
        vscode.window.showInformationMessage('KODA: applied ' + (msg.edits || []).length + ' file(s).');
      } else if (msg.type === 'openDiff') {
        await showDiffPreview(msg.edit.path, msg.edit.content, 'KODA: ' + msg.edit.path);
      } else if (msg.type === 'getFiles') {
        const files = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,dist,build,out,.next,.cache}/**', msg.limit || 200);
        webviewView.webview.postMessage({ type: 'fileList', files: files.map(f => relPath(f.fsPath)).sort() });
      } else if (msg.type === 'getSelection') {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) {
          webviewView.webview.postMessage({ type: 'selectionInfo', selection: null });
          return;
        }
        webviewView.webview.postMessage({
          type: 'selectionInfo',
          selection: {
            path: relPath(editor.document.uri.fsPath),
            startLine: editor.selection.start.line + 1,
            endLine: editor.selection.end.line + 1,
            text: editor.document.getText(editor.selection)
          }
        });
      } else if (msg.type === 'updateSetting') {
        try {
          await vscode.workspace.getConfiguration('koda').update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
        } catch (e) {
          vscode.window.showErrorMessage('KODA: failed to save setting - ' + e.message);
        }
      } else if (msg.type === 'resetSettings') {
        const cfgUpdate = vscode.workspace.getConfiguration('koda');
        const keys = ['model', 'temperature', 'autoApply', 'webSearchByDefault', 'showSources', 'confirmDelete', 'maxContextFiles'];
        for (const k of keys) {
          try { await cfgUpdate.update(k, undefined, vscode.ConfigurationTarget.Global); } catch (_) {}
        }
        this.pushConfig();
      }
    });

    if (configChangeDisposable) configChangeDisposable.dispose();
    configChangeDisposable = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('koda')) this.pushConfig();
    });
  }

  async handleAsk(msg) {
    const view = this.view;
    if (!view) return;
    const conv = this.currentConv();
    if (!conv) return;
    const cfg = getConfig();
    const workerUrl = cfg.workerUrl;
    if (!workerUrl) return view.webview.postMessage({ type: 'error', message: 'Set koda.workerUrl in settings.' });

    try {
      const ctx = await gatherContext({ mentions: msg.mentions || [], includeOpenFiles: true });
      const expanded = expandSlash(msg.message, ctx);

      const cleanHistory = conv.messages.slice(-12).map(m => ({
        role: m.role,
        content: String(m.content || '')
      }));

      conv.messages.push({ role: 'user', content: msg.message });
      if (conv.messages.filter(m => m.role === 'user').length === 1) {
        conv.title = makeTitle(msg.message);
      }
      conv.updatedAt = Date.now();
      this._save();
      this._pushList();

      this.currentAbort = new AbortController();

      const res = await fetch(workerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: expanded,
          history: cleanHistory,
          webSearch: !!msg.webSearch,
          stream: true,
          mode: 'agent',
          model: cfg.model,
          temperature: cfg.temperature,
          context: ctx
        }),
        signal: this.currentAbort.signal
      });

      if (!res.ok) {
        let detail = 'Worker returned ' + res.status;
        try {
          const err = await res.json();
          if (err.error) detail = err.error;
          if (err.detail) detail += ' - ' + String(err.detail).slice(0, 200);
        } catch (_) {}
        throw new Error(detail);
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buffer = '';
      let fullText = '';
      let sources = [];
      let pendingChunk = '';
      let lastFlush = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += dec.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            if (j.delta) {
              fullText += j.delta;
              pendingChunk += j.delta;
              const now = Date.now();
              if (now - lastFlush > 40) {
                view.webview.postMessage({ type: 'chunk', delta: pendingChunk });
                pendingChunk = '';
                lastFlush = now;
              }
            } else if (j.sources) {
              sources = j.sources;
            } else if (j.error) {
              throw new Error(j.error);
            }
          } catch (e) {
            if (e.message && e.message.indexOf('Unexpected') !== 0) throw e;
          }
        }
      }
      if (pendingChunk) view.webview.postMessage({ type: 'chunk', delta: pendingChunk });

      const edits = parseEdits(fullText);
      conv.messages.push({ role: 'assistant', content: fullText, edits, sources });
      conv.updatedAt = Date.now();
      this._save();
      this._pushList();

      view.webview.postMessage({ type: 'done', reply: fullText, edits, sources });
    } catch (e) {
      if (e.name === 'AbortError') {
        view.webview.postMessage({ type: 'aborted' });
      } else {
        view.webview.postMessage({ type: 'error', message: e.message });
      }
    } finally {
      this.currentAbort = null;
    }
  }

  async handleApply(msg) {
    try {
      const res = await applyEdit(msg.edit);
      if (!msg.silent) vscode.window.showInformationMessage('KODA: ' + (res.created ? 'Created ' : 'Updated ') + msg.edit.path);
    } catch (e) {
      vscode.window.showErrorMessage('KODA: apply failed - ' + e.message);
    }
  }

  clear() { this.clearCurrent(); }
  postMessage(m) { if (this.view) this.view.webview.postMessage(m); }
}

class KodaCodeActionProvider {
  provideCodeActions(document, range) {
    if (range.isEmpty) return [];
    const items = [
      { title: 'KODA: Explain this', cmd: 'explain' },
      { title: 'KODA: Fix bugs here', cmd: 'fix' },
      { title: 'KODA: Write tests', cmd: 'test' },
      { title: 'KODA: Add docs', cmd: 'doc' },
      { title: 'KODA: Refactor this', cmd: 'refactor' },
      { title: 'KODA: Optimize this', cmd: 'optimize' }
    ];
    return items.map(it => {
      const action = new vscode.CodeAction(it.title, vscode.CodeActionKind.Refactor);
      action.command = { command: 'koda.runAction', title: it.title, arguments: [it.cmd] };
      return action;
    });
  }
}

async function inlineEdit() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;
  const sel = editor.selection;
  const selectedText = doc.getText(sel);
  const hasSelection = !sel.isEmpty;

  const instruction = await vscode.window.showInputBox({
    prompt: hasSelection ? 'KODA: edit selected code' : 'KODA: edit this file',
    placeHolder: 'e.g. add error handling, refactor, add types...',
    ignoreFocusOut: true
  });
  if (!instruction) return;

  const filePath = relPath(doc.uri.fsPath);
  const fileContent = doc.getText();
  const cfg = getConfig();
  const message = hasSelection
    ? 'Edit this selected code from ' + filePath + '. Return ONLY the modified version of the selection, wrapped in a single fenced code block with path=' + filePath + '.\n\nINSTRUCTION: ' + instruction + '\n\nSELECTED:\n```' + doc.languageId + '\n' + selectedText + '\n```'
    : 'Edit this file ' + filePath + '. Return the FULL new file content in a single fenced code block with path=' + filePath + '.\n\nINSTRUCTION: ' + instruction + '\n\nFILE:\n```' + doc.languageId + '\n' + fileContent + '\n```';

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'KODA is editing...', cancellable: false },
    async () => {
      try {
        const data = await callWorker({
          message,
          history: [],
          webSearch: false,
          mode: 'agent',
          model: cfg.model,
          temperature: cfg.temperature,
          context: {
            activeFile: { path: filePath, language: doc.languageId, content: fileContent.slice(0, 20000) },
            selection: hasSelection ? { path: filePath, text: selectedText } : null
          }
        });
        const reply = data.reply || '';
        const edits = parseEdits(reply);
        if (!edits.length) return vscode.window.showWarningMessage('KODA: no code block returned.');
        const e = edits[0];
        if (hasSelection) {
          const we = new vscode.WorkspaceEdit();
          we.replace(doc.uri, sel, e.content);
          await vscode.workspace.applyEdit(we);
          vscode.window.showInformationMessage('KODA: selection replaced.');
        } else {
          await showDiffPreview(filePath, e.content, 'KODA: ' + filePath);
          const answer = await vscode.window.showInformationMessage('KODA: apply this change to ' + filePath + '?', 'Apply', 'Cancel');
          if (answer === 'Apply') {
            const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
            const we = new vscode.WorkspaceEdit();
            we.replace(doc.uri, fullRange, e.content);
            await vscode.workspace.applyEdit(we);
            vscode.window.showInformationMessage('KODA: ' + filePath + ' updated.');
          }
        }
      } catch (err) {
        vscode.window.showErrorMessage('KODA: ' + err.message);
      }
    }
  );
}

let configChangeDisposable = null;

function activate(context) {
  diffProvider = new KodaDiffProvider();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('koda-diff', diffProvider));

  const chat = new KodaChatView(context.extensionUri, context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('koda.chatView', chat, { webviewOptions: { retainContextWhenHidden: true } })
  );

  context.subscriptions.push(vscode.commands.registerCommand('koda.openChat', () => vscode.commands.executeCommand('koda.chatView.focus')));
  context.subscriptions.push(vscode.commands.registerCommand('koda.newChat', () => { vscode.commands.executeCommand('koda.chatView.focus'); chat.newChat(); }));
  context.subscriptions.push(vscode.commands.registerCommand('koda.clearChat', () => chat.clear()));
  context.subscriptions.push(vscode.commands.registerCommand('koda.inlineEdit', inlineEdit));

  context.subscriptions.push(vscode.commands.registerCommand('koda.explainSelection', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) return vscode.window.showWarningMessage('Select code first.');
    const sel = editor.document.getText(editor.selection);
    const lang = editor.document.languageId;
    const prompt = 'Explain this ' + lang + ' code using your 4-step method:\n\n```' + lang + '\n' + sel + '\n```';
    await vscode.commands.executeCommand('koda.chatView.focus');
    chat.postMessage({ type: 'insertPrompt', prompt, autoSend: true });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('koda.runAction', async (cmd) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const sel = editor.selection;
    const selText = sel.isEmpty ? editor.document.getText().slice(0, 4000) : editor.document.getText(sel);
    const lang = editor.document.languageId;
    const filePath = relPath(editor.document.uri.fsPath);
    const body = 'File: `' + filePath + '`\n\n```' + lang + '\n' + selText + '\n```';
    const message = '/' + cmd + ' ' + body;
    await vscode.commands.executeCommand('koda.chatView.focus');
    chat.postMessage({ type: 'insertPrompt', prompt: message, autoSend: true });
  }));

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      new KodaCodeActionProvider(),
      { providedCodeActionKinds: [vscode.CodeActionKind.Refactor] }
    )
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
