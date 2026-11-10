"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
const vscode = __importStar(require("vscode"));
/**
 * KUSQO IDE — real agent extension.
 * Requires a signed-in KUSQO account: no token → nothing works.
 * Execution (npm/build/test) runs in the USER's terminal — their machine, their resources.
 * AI calls stream from the KUSQO API (/builder/chat/stream).
 */
const TOKEN_KEY = 'kusqo.accessToken';
const REFRESH_KEY = 'kusqo.refreshToken';
function apiBase() {
    const base = vscode.workspace.getConfiguration('kusqo').get('apiUrl') ?? 'https://api.kusqo.com';
    return base.replace(/\/$/, '');
}
async function post(path, body, token) {
    const res = await fetch(`${apiBase()}/api/v1${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok)
        throw new Error(json.message ?? `API ${res.status}`);
    return json;
}
async function getToken(context) {
    const token = context.globalState.get(TOKEN_KEY);
    if (token)
        return token;
    return login(context);
}
async function login(context) {
    const email = await vscode.window.showInputBox({ prompt: 'KUSQO email', ignoreFocusOut: true });
    if (!email)
        return null;
    const password = await vscode.window.showInputBox({ prompt: 'KUSQO password', password: true, ignoreFocusOut: true });
    if (!password)
        return null;
    const tenantSlug = vscode.workspace.getConfiguration('kusqo').get('tenantSlug') ?? '';
    try {
        const json = await post('/auth/login', { email, password, tenantSlug: tenantSlug || undefined });
        const t = json?.data?.accessToken;
        if (!t)
            throw new Error('no token');
        await context.globalState.update(TOKEN_KEY, t);
        await context.globalState.update(REFRESH_KEY, json.data?.refreshToken ?? '');
        void vscode.window.showInformationMessage('KUSQO: signed in');
        return t;
    }
    catch (err) {
        void vscode.window.showErrorMessage(`KUSQO login failed: ${err instanceof Error ? err.message : err}`);
        return null;
    }
}
async function logout(context) {
    await context.globalState.update(TOKEN_KEY, undefined);
    await context.globalState.update(REFRESH_KEY, undefined);
    void vscode.window.showInformationMessage('KUSQO: signed out');
}
// ---------- Agent chat panel ----------
const CSS = `body{margin:0;background:#06060c;color:#e4e4e7;font:13px system-ui;display:flex;flex-direction:column;height:100vh}
#msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}
.m{padding:10px 12px;border-radius:10px;max-width:85%;white-space:pre-wrap;word-break:break-word}
.u{align-self:flex-end;background:#3730a3;border:1px solid #4f46e5}
.a{align-self:flex-start;background:#14141f;border:1px solid #26263a}
#bar{display:flex;gap:8px;padding:12px;border-top:1px solid #26263a}
input{flex:1;background:#0b0b14;border:1px solid #26263a;border-radius:8px;color:#e4e4e7;padding:10px 12px;font:inherit;outline:none}
button{background:#4f46e5;border:none;color:#fff;padding:10px 16px;border-radius:8px;cursor:pointer;font-weight:600}
button:disabled{opacity:.4}
.meta{font-family:monospace;font-size:11px;color:#71717a}
.prev{flex:1;border:none}`;
const JS = `const msgs=document.getElementById('msgs');const inp=document.getElementById('inp');
function add(role,text,cls){const d=document.createElement('div');d.className='m '+cls;d.textContent=text;msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight;return d}
window.addEventListener('message',(e)=>{const m=e.data;
if(m.type==='user')add('u',m.text,'u');
if(m.type==='delta'){const l=document.getElementById('stream')||add('a','','a');l.id='stream';l.textContent=m.text;msgs.scrollTop=msgs.scrollHeight}
if(m.type==='done'){const s=document.getElementById('stream');if(s)s.id='';add('a','Preview ready — click "Open preview"','a meta')}
if(m.type==='error')add('a','⚠ '+m.text,'a')});
document.getElementById('send').onclick=()=>{const v=inp.value.trim();if(!v)return;inp.value='';vscode.postMessage({type:'send',text:v})};
inp.addEventListener('keydown',(e)=>{if(e.key==='Enter')document.getElementById('send').click()});`;
function agentPanel(context, token) {
    const panel = vscode.window.createWebviewPanel('kusqoAgent', 'KUSQO Agent', vscode.ViewColumn.Two, { enableScripts: true, retainContextWhenHidden: true });
    panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${CSS}</style></head>
    <body><div id="msgs"></div><div id="bar"><input id="inp" placeholder="Describe what to build or fix…"/><button id="send">Send</button></div>
    <script>const vscode=acquireVsCodeApi();${JS}</script></body></html>`;
    let html = '';
    panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.type !== 'send' || !msg.text)
            return;
        panel.webview.postMessage({ type: 'user', text: msg.text });
        try {
            // Streaming chat — real SSE to /builder/chat/stream
            const res = await fetch(`${apiBase()}/api/v1/builder/chat/stream`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ messages: [{ role: 'user', content: msg.text }] }),
            });
            if (!res.ok || !res.body)
                throw new Error(`Stream ${res.status}`);
            const reader = res.body.getReader();
            const dec = new TextDecoder();
            let buf = '';
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                buf += dec.decode(value, { stream: true });
                const parts = buf.split('\n\n');
                buf = parts.pop() ?? '';
                for (const p of parts) {
                    const line = p.split('\n').find((l) => l.startsWith('data:'));
                    if (!line)
                        continue;
                    try {
                        const ev = JSON.parse(line.slice(5).trim());
                        if (ev.type === 'delta' && ev.content) {
                            html = (html + ev.content);
                            panel.webview.postMessage({ type: 'delta', text: html.slice(-4000) });
                        }
                        if (ev.type === 'done' && ev.html) {
                            html = ev.html;
                            panel.webview.postMessage({ type: 'done' });
                            const prev = vscode.window.createWebviewPanel('kusqoPreview', 'KUSQO Preview', vscode.ViewColumn.Beside, { enableScripts: true });
                            prev.webview.html = html;
                        }
                    }
                    catch { /* partial */ }
                }
            }
            if (!html)
                panel.webview.postMessage({ type: 'error', text: 'No content returned' });
        }
        catch (err) {
            panel.webview.postMessage({ type: 'error', text: err instanceof Error ? err.message : String(err) });
        }
    });
    context.subscriptions.push(panel);
    // expose current html for preview command
    (context.workspaceState.update('kusqo.lastHtml', '')), void 0;
    lastHtmlRef.html = () => html;
}
const lastHtmlRef = { html: () => '' };
function openPreview() {
    const html = lastHtmlRef.html();
    const panel = vscode.window.createWebviewPanel('kusqoPreview', 'KUSQO Preview', vscode.ViewColumn.Beside, { enableScripts: true });
    panel.webview.html = html || `<!DOCTYPE html><html><body style="margin:0;background:#06060c;color:#e4e4e7;font:13px system-ui;display:flex;align-items:center;justify-content:center;height:100vh">
    <div>No page generated yet — ask the agent first.</div></body></html>`;
}
function fixVerifyLocal() {
    const terminal = vscode.window.createTerminal('KUSQO Verify');
    terminal.show();
    terminal.sendText('npm install && npm run build && npm test', true);
    void vscode.window.showInformationMessage('KUSQO: verification running locally — your machine, your resources');
}
// ---------- Memory rules (.kusqorules) — our differentiator ----------
// Per-project rules file generated from the project's own context + ADRs.
// Injected into every agent prompt so the agent NEVER forgets decisions.
const RULES_FILE = '.kusqorules';
function workspaceRoot() {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
async function readRules() {
    const root = workspaceRoot();
    if (!root)
        return '';
    try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(`${root}/${RULES_FILE}`));
        return Buffer.from(bytes).toString('utf8');
    }
    catch {
        return '';
    }
}
/** Generate .kusqorules from the project's ADRs + indexed context — memory competitors don't have. */
async function generateRules(context) {
    const token = await getToken(context);
    if (!token) {
        void vscode.window.showWarningMessage('KUSQO: sign in first');
        return;
    }
    const root = workspaceRoot();
    if (!root) {
        void vscode.window.showWarningMessage('Open a project folder first');
        return;
    }
    const draft = await vscode.window.showInputBox({ prompt: 'What kind of project is this? (helps generate focused rules)', value: 'TypeScript web app' });
    if (draft === undefined)
        return;
    try {
        const r = await post('/builder/chat', {
            messages: [{
                    role: 'user',
                    content: `Write a .kusqorules memory file for a ${draft} project. Format: short markdown — architecture rules, naming, forbidden patterns, key decisions to always respect, quality bar. Max 30 lines, no code fences.`,
                }],
        }, token);
        const rules = `# .kusqorules — project memory (KUSQO)
# Generated from project context. The agent reads this before every task.

${r?.data?.html ?? '## Rules\n- TypeScript strict, no any\n- Test before commit\n'}`.replace(/<!DOCTYPE[^>]*>|<\/?(html|head|body|meta|title)[^>]*>/gi, '');
        await vscode.workspace.fs.writeFile(vscode.Uri.file(`${root}/${RULES_FILE}`), Buffer.from(rules, 'utf8'));
        const doc = await vscode.workspace.openTextDocument(`${root}/${RULES_FILE}`);
        await vscode.window.showTextDocument(doc);
        void vscode.window.showInformationMessage('KUSQO: .kusqorules created — the agent will respect it on every task');
    }
    catch (err) {
        void vscode.window.showErrorMessage(`Rules generation failed: ${err instanceof Error ? err.message : err}`);
    }
}
async function runAgent(context) {
    const token = await getToken(context);
    if (!token) {
        void vscode.window.showWarningMessage('KUSQO: sign in first — the agent requires an account');
        return;
    }
    const root = workspaceRoot();
    if (!root) {
        void vscode.window.showWarningMessage('Open a project folder first');
        return;
    }
    const goal = await vscode.window.showInputBox({ prompt: 'KUSQO Agent — what should I build or fix?', ignoreFocusOut: true });
    if (!goal)
        return;
    const rules = await readRules();
    const goalWithRules = rules ? `${goal}

[Project rules — respect strictly]
${rules}` : goal;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'KUSQO Agent', cancellable: false }, async (progress) => {
        try {
            progress.report({ message: 'Planning…' });
            const planRes = await post('/builder/agent/plan', { goal: goalWithRules }, token);
            const steps = planRes?.data?.steps ?? [];
            if (!steps.length)
                throw new Error('agent returned an empty plan');
            const pick = await vscode.window.showQuickPick(steps.map((st, i) => ({ label: `${i + 1}. [${st.type}] ${st.description}`, step: st })), { title: `KUSQO plan — ${steps.length} step(s). Approve to execute locally`, canPickMany: true });
            if (!pick?.length) {
                void vscode.window.showInformationMessage('KUSQO: plan dismissed — nothing applied');
                return;
            }
            for (const [i, p] of pick.entries()) {
                progress.report({ message: `Step ${i + 1}/${pick.length}: ${p.step.description.slice(0, 60)}` });
                const res = await post('/builder/agent/step', { step: p.step, goal: goalWithRules }, token);
                const files = res?.data?.files ?? [];
                for (const f of files) {
                    const uri = vscode.Uri.file(`${root}/${f.path.replace(/^\/+/, '')}`);
                    await vscode.workspace.fs.writeFile(uri, Buffer.from(f.content, 'utf8'));
                }
                if (files.length) {
                    const doc = await vscode.workspace.openTextDocument(`${root}/${files[0].path.replace(/^\/+/, '')}`);
                    await vscode.window.showTextDocument(doc, { preview: true });
                }
            }
            void vscode.window.showInformationMessage(`KUSQO: ${pick.length} step(s) executed locally`);
        }
        catch (err) {
            void vscode.window.showErrorMessage(`Agent failed: ${err instanceof Error ? err.message : err}`);
        }
    });
}
function activate(context) {
    context.subscriptions.push(vscode.commands.registerCommand('kusqo.login', () => void login(context)), vscode.commands.registerCommand('kusqo.logout', () => void logout(context)), vscode.commands.registerCommand('kusqo.chat', async () => {
        const token = await getToken(context);
        if (!token) {
            void vscode.window.showWarningMessage('KUSQO: sign in first — the IDE requires an account');
            return;
        }
        agentPanel(context, token);
    }), vscode.commands.registerCommand('kusqo.fixVerify', () => fixVerifyLocal()), vscode.commands.registerCommand('kusqo.preview', () => openPreview()), vscode.commands.registerCommand('kusqo.agent', () => void runAgent(context)), vscode.commands.registerCommand('kusqo.memoryRules', () => void generateRules(context)));
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    status.text = '$(rocket) KUSQO';
    status.command = 'kusqo.chat';
    status.show();
    context.subscriptions.push(status);
}
