const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('koda');
  return {
    workerUrl: String(cfg.get('workerUrl') || '').replace(/\/+$/, ''),
    autoApply: !!cfg.get('autoApply'),
    maxContextFiles: Number(cfg.get('maxContextFiles') || 6),
    webSearchByDefault: !!cfg.get('webSearchByDefault')
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

class KodaChatView {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.view = null;
    this.history = [];
    this.currentAbort = null;
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
      .replace(/\{\{WEBSEARCH_DEFAULT\}\}/g, cfg.webSearchByDefault ? 'true' : 'false');
    webviewView.webview.html = html;

    webviewView.webview.onDidReceiveMessage(async msg => {
      if (!msg || !msg.type) return;
      if (msg.type === 'ask') {
        await this.handleAsk(msg);
      } else if (msg.type === 'stop') {
        if (this.currentAbort) { try { this.currentAbort.abort(); } catch (_) {} }
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
      }
    });
  }

  async handleAsk(msg) {
    const view = this.view;
    if (!view) return;
    const { workerUrl } = getConfig();
    if (!workerUrl) {
      return view.webview.postMessage({ type: 'error', message: 'Set koda.workerUrl in settings.' });
    }

    try {
      const ctx = await gatherContext({ mentions: msg.mentions || [], includeOpenFiles: true });
      const expanded = expandSlash(msg.message, ctx);

      this.currentAbort = new AbortController();

      const res = await fetch(workerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: expanded,
          history: this.history.slice(-12),
          webSearch: !!msg.webSearch,
          stream: true,
          mode: 'agent',
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
      if (pendingChunk) {
        view.webview.postMessage({ type: 'chunk', delta: pendingChunk });
      }

      const edits = parseEdits(fullText);
      this.history.push({ role: 'user', content: msg.message });
      this.history.push({ role: 'assistant', content: fullText });
      if (this.history.length > 24) this.history = this.history.slice(-24);

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

  clear() {
    this.history = [];
    if (this.view) this.view.webview.postMessage({ type: 'clear' });
  }

  postMessage(m) { if (this.view) this.view.webview.postMessage(m); }
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
  const message = hasSelection
    ? 'Edit this selected code from ' + filePath + '. Return ONLY the modified version of the selection, wrapped in a single fenced code block with path=' + filePath + '.\n\nINSTRUCTION: ' + instruction + '\n\nSELECTED:\n```' + doc.languageId + '\n' + selectedText + '\n```'
    : 'Edit this file ' + filePath + '. Return the FULL new file content in a single fenced code block with path=' + filePath + '.\n\nINSTRUCTION: ' + instruction + '\n\nFILE:\n```' + doc.languageId + '\n' + fileContent + '\n```';

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'KODA is editing...', cancellable: false },
    async () => {
      try {
        const data = await callWorker({
          message, history: [], webSearch: false, mode: 'agent',
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

function activate(context) {
  diffProvider = new KodaDiffProvider();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('koda-diff', diffProvider));
  const chat = new KodaChatView(context.extensionUri);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('koda.chatView', chat, { webviewOptions: { retainContextWhenHidden: true } }));
  context.subscriptions.push(vscode.commands.registerCommand('koda.openChat', () => vscode.commands.executeCommand('koda.chatView.focus')));
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
}

function deactivate() {}

module.exports = { activate, deactivate };
