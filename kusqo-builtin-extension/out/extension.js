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
/* eslint-disable max-lines, max-depth -- TODO(IDE): split extension.ts into modules (chat panel, agent loop, completion) */
const vscode = __importStar(require("vscode"));
const child_process_1 = require("child_process");
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
        headers: {
            'content-type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({})));
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
    const password = await vscode.window.showInputBox({
        prompt: 'KUSQO password',
        password: true,
        ignoreFocusOut: true,
    });
    if (!password)
        return null;
    const tenantSlug = vscode.workspace.getConfiguration('kusqo').get('tenantSlug') ?? '';
    try {
        const json = await post('/auth/login', {
            email,
            password,
            tenantSlug: tenantSlug || undefined,
        });
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
#hdr{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #26263a;font-size:11px;color:#71717a}
#hdr b{background:linear-gradient(90deg,#818cf8,#e879f9);-webkit-background-clip:text;background-clip:text;color:transparent;font-size:12px}
#trust{margin-left:auto;background:#0b0b14;border:1px solid #26263a;border-radius:6px;color:#a5b4fc;padding:3px 8px;font-size:10px;cursor:pointer}
#msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}
.m{padding:10px 12px;border-radius:10px;max-width:92%;white-space:pre-wrap;word-break:break-word;line-height:1.5}
.u{align-self:flex-end;background:linear-gradient(135deg,#4f46e5,#7c3aed);border:1px solid #6366f1}
.a{align-self:flex-start;background:#11111e;border:1px solid #26263a}
.a code{background:#0b0b14;padding:1px 5px;border-radius:4px;font-family:monospace;font-size:11px;color:#a5b4fc}
.a pre{background:#0b0b14;border:1px solid #26263a;border-radius:8px;padding:8px;overflow-x:auto;white-space:pre}
.a pre code{background:none;padding:0}
.a h3{font-size:14px;color:#a5b4fc;margin:8px 0 4px}
.plan{border-left:2px solid #6366f1;background:rgba(99,102,241,.08);border-radius:0 8px 8px 0;padding:6px 10px;font-size:11px;color:#a5b4fc;align-self:flex-start}
.stats{align-self:flex-start;font:11px monospace;color:#4ade80;padding:2px 8px;border:1px solid #166534;border-radius:99px}
#bar{display:flex;gap:8px;padding:12px;border-top:1px solid #26263a}
input{flex:1;background:#0b0b14;border:1px solid #26263a;border-radius:8px;color:#e4e4e7;padding:10px 12px;font:inherit;outline:none}
button{background:linear-gradient(135deg,#6366f1,#a855f7);border:none;color:#fff;padding:10px 16px;border-radius:8px;cursor:pointer;font-weight:600}
button:disabled{opacity:.4}
.meta{font-family:monospace;font-size:11px;color:#71717a}`;
/* eslint-disable no-useless-escape -- injected script text; the escapes are real regex in the child document */
const JS = `const msgs=document.getElementById('msgs');const inp=document.getElementById('inp');
const TRUST=['Read','Suggest','Auto'];let trust=1;
document.getElementById('trust').onclick=()=>{trust=(trust+1)%3;document.getElementById('trust').textContent='Trust: '+TRUST[trust];vscode.postMessage({type:'trust',level:trust})};
function md(t){return t.replace(/&/g,'&amp;').replace(/</g,'&lt;')
.replace(/\*\*([^*]+)\*\*/g,'<b>$1<\/b>')}
function add(cls,html){const d=document.createElement('div');d.className='m '+cls;d.innerHTML=cls==='u'?html:md(html);msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight;return d}
window.addEventListener('message',(e)=>{const m=e.data;
if(m.type==='user')add('u',m.text);
if(m.type==='plan'){const d=document.createElement('div');d.className='plan';d.innerHTML='◈ '+m.text;msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight}
if(m.type==='stats'){const d=document.createElement('div');d.className='stats';d.textContent=m.text;msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight}
if(m.type==='delta'){const l=document.getElementById('stream')||add('a','');l.id='stream';l.innerHTML=md(m.text);msgs.scrollTop=msgs.scrollHeight}
if(m.type==='done'){const s=document.getElementById('stream');if(s)s.id='';add('a','Preview ready — click Open preview')}
if(m.type==='error')add('a','⚠ '+m.text)});
document.getElementById('send').onclick=()=>{const v=inp.value.trim();if(!v)return;inp.value='';vscode.postMessage({type:'send',text:v})};
inp.addEventListener('keydown',(e)=>{if(e.key==='Enter')document.getElementById('send').click()});`;
/* eslint-enable no-useless-escape */
function agentPanel(context, token) {
    const panel = vscode.window.createWebviewPanel('kusqoAgent', 'KUSQO Agent', vscode.ViewColumn.Two, { enableScripts: true, retainContextWhenHidden: true });
    panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${CSS}</style></head>
    <body><div id="hdr"><b>KUSQO AGENT</b><span>chat · plan · review</span><button id="trust" title="Agent autonomy">Trust: Suggest</button></div>
    <div id="msgs"></div><div id="bar"><input id="inp" placeholder="Describe what to build or fix — @file for context…"/><button id="send">Send</button></div>
    <script>const vscode=acquireVsCodeApi();${JS}</script></body></html>`;
    let html = '';
    let trustLevel = 1; // 0 Read · 1 Suggest · 2 Auto
    /* eslint-disable-next-line complexity -- legacy chat-panel state machine, needs the same split as above */
    panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === 'trust') {
            trustLevel = msg.level ?? 1;
            return;
        }
        if (msg.type !== 'send' || !msg.text)
            return;
        panel.webview.postMessage({ type: 'user', text: msg.text });
        try {
            // @-context: active file + selection ride along with every prompt (like @refs)
            const ed = vscode.window.activeTextEditor;
            let promptText = msg.text;
            if (ed && /@file|@sel|@code/i.test(msg.text)) {
                const code = ed.selection.isEmpty
                    ? ed.document.getText().slice(0, 6000)
                    : ed.document.getText(ed.selection).slice(0, 6000);
                promptText = `${msg.text}\n\n[${vscode.workspace.asRelativePath(ed.document.uri)}]\n${code}`;
            }
            const rules = await readRules();
            if (rules)
                promptText += `\n\n[Project rules]\n${rules.slice(0, 1500)}`;
            if (trustLevel === 0)
                promptText = `${promptText}\n\n[TRUST:READ — explain only, do NOT modify anything]`;
            // Streaming chat — real SSE to /builder/chat/stream
            const res = await fetch(`${apiBase()}/api/v1/builder/chat/stream`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ messages: [{ role: 'user', content: promptText }] }),
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
                            html = html + ev.content;
                            panel.webview.postMessage({ type: 'delta', text: html.slice(-4000) });
                        }
                        if (ev.type === 'done' && ev.html) {
                            html = ev.html;
                            panel.webview.postMessage({ type: 'done' });
                            const prev = vscode.window.createWebviewPanel('kusqoPreview', 'KUSQO Preview', vscode.ViewColumn.Beside, { enableScripts: true });
                            prev.webview.html = html;
                        }
                    }
                    catch {
                        /* partial */
                    }
                }
            }
            if (!html)
                panel.webview.postMessage({ type: 'error', text: 'No content returned' });
        }
        catch (err) {
            panel.webview.postMessage({
                type: 'error',
                text: err instanceof Error ? err.message : String(err),
            });
        }
    });
    context.subscriptions.push(panel);
    // expose current html for preview command
    void context.workspaceState.update('kusqo.lastHtml', '');
    lastHtmlRef.html = () => html;
}
const lastHtmlRef = { html: () => '' };
function openPreview() {
    const html = lastHtmlRef.html();
    const panel = vscode.window.createWebviewPanel('kusqoPreview', 'KUSQO Preview', vscode.ViewColumn.Beside, { enableScripts: true });
    panel.webview.html =
        html ||
            `<!DOCTYPE html><html><body style="margin:0;background:#06060c;color:#e4e4e7;font:13px system-ui;display:flex;align-items:center;justify-content:center;height:100vh">
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
    const draft = await vscode.window.showInputBox({
        prompt: 'What kind of project is this? (helps generate focused rules)',
        value: 'TypeScript web app',
    });
    if (draft === undefined)
        return;
    try {
        const r = await post('/builder/chat', {
            messages: [
                {
                    role: 'user',
                    content: `Write a .kusqorules memory file for a ${draft} project. Format: short markdown — architecture rules, naming, forbidden patterns, key decisions to always respect, quality bar. Max 30 lines, no code fences.`,
                },
            ],
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
    const goal = await vscode.window.showInputBox({
        prompt: 'KUSQO Agent — what should I build or fix?',
        ignoreFocusOut: true,
    });
    if (!goal)
        return;
    const rules = await readRules();
    const goalWithRules = rules
        ? `${goal}

[Project rules — respect strictly]
${rules}`
        : goal;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'KUSQO Agent', cancellable: false }, async (progress) => {
        try {
            progress.report({ message: 'Planning…' });
            const planRes = await post('/builder/agent/plan', { goal: goalWithRules }, token);
            const steps = planRes?.data?.steps ?? [];
            if (!steps.length)
                throw new Error('agent returned an empty plan');
            const pick = await vscode.window.showQuickPick(steps.map((st, i) => ({ label: `${i + 1}. [${st.type}] ${st.description}`, step: st })), {
                title: `KUSQO plan — ${steps.length} step(s). Approve to execute locally`,
                canPickMany: true,
            });
            if (!pick?.length) {
                void vscode.window.showInformationMessage('KUSQO: plan dismissed — nothing applied');
                return;
            }
            // Change-guard: snapshot every touched path BEFORE the first write,
            // so a failed verification can roll the workspace back exactly.
            const snap = new Map();
            const written = [];
            for (const [i, p] of pick.entries()) {
                progress.report({
                    message: `Step ${i + 1}/${pick.length}: ${p.step.description.slice(0, 60)}`,
                });
                const res = await post('/builder/agent/step', { step: p.step, goal: goalWithRules }, token);
                const files = res?.data?.files ?? [];
                const paths = files.map((f) => f.path.replace(/^\/+/, ''));
                for (const [rel, bytes] of await snapshotFiles(root, paths))
                    snap.set(rel, bytes);
                for (const f of files) {
                    const uri = vscode.Uri.file(`${root}/${f.path.replace(/^\/+/, '')}`);
                    await vscode.workspace.fs.writeFile(uri, Buffer.from(f.content, 'utf8'));
                    written.push(f.path.replace(/^\/+/, ''));
                }
                if (files.length) {
                    const doc = await vscode.workspace.openTextDocument(`${root}/${files[0].path.replace(/^\/+/, '')}`);
                    await vscode.window.showTextDocument(doc, { preview: true });
                }
            }
            if (!written.length) {
                void vscode.window.showInformationMessage('KUSQO: agent emitted no files');
                return;
            }
            const action = await vscode.window.showInformationMessage(`KUSQO: ${pick.length} step(s), ${written.length} file(s) applied`, 'Verify changes', 'Revert all', 'Keep');
            if (action === 'Revert all') {
                await restoreSnapshot(root, snap);
                void vscode.window.showInformationMessage('KUSQO: changes reverted');
                return;
            }
            if (action === 'Verify changes') {
                const report = await verifyProject(context);
                if (report && report.verdict !== 'verified') {
                    const rb = await vscode.window.showWarningMessage('Verification did not pass — revert the applied files?', 'Revert', 'Keep anyway');
                    if (rb === 'Revert') {
                        await restoreSnapshot(root, snap);
                        void vscode.window.showInformationMessage('KUSQO: changes reverted');
                    }
                }
            }
        }
        catch (err) {
            void vscode.window.showErrorMessage(`Agent failed: ${err instanceof Error ? err.message : err}`);
        }
    });
}
// ---------- Cmd+K inline edit — select code → AI rewrites → Accept/Revert ----------
async function inlineEdit(context) {
    const editor = vscode.window.activeTextEditor;
    if (!editor)
        return;
    const sel = editor.selection;
    if (sel.isEmpty) {
        void vscode.window.showWarningMessage('KUSQO: select code first, then Ctrl+K');
        return;
    }
    const token = await getToken(context);
    if (!token) {
        void vscode.window.showWarningMessage('KUSQO: sign in first');
        return;
    }
    const instr = await vscode.window.showInputBox({
        prompt: 'Edit this selection — describe the change',
        ignoreFocusOut: true,
    });
    if (!instr)
        return;
    const code = editor.document.getText(sel);
    const rules = await readRules();
    try {
        const r = await post('/builder/chat', {
            mode: 'ask',
            messages: [
                {
                    role: 'user',
                    content: `Edit ONLY this ${editor.document.languageId} code per the instruction. Return ONLY the edited code — no fences, no explanation.\n\nInstruction: ${instr}${rules ? `\n\nProject rules:\n${rules.slice(0, 1500)}` : ''}\n\nCode:\n${code.slice(0, 8000)}`,
                },
            ],
        }, token);
        const out = (r?.data?.html ?? '').replace(/^```\w*\n?|\n?```$/g, '').trim();
        if (!out) {
            void vscode.window.showWarningMessage('KUSQO: empty edit returned');
            return;
        }
        await editor.edit((b) => b.replace(sel, out));
        const pick = await vscode.window.showInformationMessage('KUSQO: edit applied', 'Accept', 'Revert');
        if (pick === 'Revert') {
            await editor.edit((b) => {
                const lines = out.split('\n');
                const endPos = lines.length === 1
                    ? sel.start.translate(0, lines[0].length)
                    : new vscode.Position(sel.start.line + lines.length - 1, lines[lines.length - 1].length);
                b.replace(new vscode.Range(sel.start, endPos), code);
            });
        }
    }
    catch (err) {
        void vscode.window.showErrorMessage(`Inline edit failed: ${err instanceof Error ? err.message : err}`);
    }
}
const PROOF_DIR = '.kusqo';
function dockerAvailable() {
    return new Promise((resolve) => {
        (0, child_process_1.exec)('docker version --format "{{.Server.Version}}"', { timeout: 5000 }, (err, out) => resolve(!err && Boolean(out.trim())));
    });
}
function runVerify(root) {
    return new Promise(async (resolve) => {
        const docker = await dockerAvailable();
        const flag = docker ? '' : ' --local';
        (0, child_process_1.exec)(`npx -y @kusqo/verify "${root}"${flag} --timeout 600`, { cwd: root, timeout: 660000, maxBuffer: 8 * 1024 * 1024 }, async () => {
            try {
                const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(`${root}/${PROOF_DIR}/kusqo-proof.json`));
                resolve(JSON.parse(Buffer.from(bytes).toString('utf8')));
            }
            catch {
                resolve({ verdict: 'unparseable', warnings: ['kusqo-verify produced no report'] });
            }
        });
    });
}
async function openProofReport(root) {
    try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(`${root}/${PROOF_DIR}/kusqo-proof.html`));
        const panel = vscode.window.createWebviewPanel('kusqoProof', 'KUSQO Proof Report', vscode.ViewColumn.Beside, {});
        panel.webview.html = Buffer.from(bytes).toString('utf8');
    }
    catch {
        void vscode.window.showWarningMessage('No proof report yet — run "KUSQO: Verify project" first');
    }
}
async function verifyProject(context) {
    const root = workspaceRoot();
    if (!root) {
        void vscode.window.showWarningMessage('Open a project folder first');
        return null;
    }
    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'KUSQO Verify',
        cancellable: false,
    }, async (progress) => {
        progress.report({ message: 'running kusqo-verify (npx)…' });
        const report = await runVerify(root);
        const failedSteps = (report.steps ?? []).filter((s) => s.ok === false || (s.exitCode ?? 0) !== 0).map((s) => s.name);
        if (report.verdict === 'verified') {
            const pick = await vscode.window.showInformationMessage('KUSQO: verified ✓ — all checks passed in the sandbox', 'Open proof report');
            if (pick)
                void openProofReport(root);
        }
        else {
            const pick = await vscode.window.showWarningMessage(`KUSQO: ${report.verdict ?? 'unknown'}${failedSteps.length ? ` — failed: ${failedSteps.join(', ')}` : ''}`, 'Open proof report', 'Ask agent to fix');
            if (pick === 'Open proof report')
                void openProofReport(root);
            if (pick === 'Ask agent to fix')
                await diagnoseVerifyFailure(context, report, failedSteps);
        }
        return report;
    });
}
async function diagnoseVerifyFailure(context, report, failedSteps) {
    const token = await getToken(context);
    if (!token)
        return;
    const r = await post('/builder/chat', {
        mode: 'ask',
        messages: [
            {
                role: 'user',
                content: `kusqo-verify verdict: ${report.verdict}. Failed steps: ${failedSteps.join(', ')}. Warnings: ${(report.warnings ?? []).slice(0, 10).join('; ')}. Diagnose the root cause and give the concrete fix (file + change).`,
            },
        ],
    }, token);
    const doc = await vscode.workspace.openTextDocument({
        content: r?.data?.html ?? 'no diagnosis',
        language: 'markdown',
    });
    await vscode.window.showTextDocument(doc, { preview: true });
}
async function snapshotFiles(root, paths) {
    const snap = new Map();
    for (const rel of paths) {
        if (snap.has(rel))
            continue;
        try {
            snap.set(rel, await vscode.workspace.fs.readFile(vscode.Uri.file(`${root}/${rel}`)));
        }
        catch {
            snap.set(rel, null);
        }
    }
    return snap;
}
async function restoreSnapshot(root, snap) {
    for (const [rel, bytes] of snap) {
        const uri = vscode.Uri.file(`${root}/${rel}`);
        if (bytes === null) {
            await vscode.workspace.fs.delete(uri, { useTrash: false }).then(undefined, () => { });
        }
        else {
            await vscode.workspace.fs.writeFile(uri, bytes);
        }
    }
}
// ---------- Self-healing Fix & Verify — errors go back to the agent ----------
async function fixVerifySelfHeal(context) {
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
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'KUSQO Fix & Verify',
        cancellable: false,
    }, async (progress) => {
        progress.report({ message: 'npm install + build…' });
        const out = await new Promise((resolve) => {
            (0, child_process_1.exec)('npm install --no-audit --no-fund && npm run build', { cwd: root, timeout: 300000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => resolve(`${stdout}\n${stderr}\n[exit:${err?.code ?? 0}]`));
        });
        if (out.includes('[exit:0]')) {
            void vscode.window.showInformationMessage('KUSQO: build clean ✓ — verified locally');
            return;
        }
        const tail = out
            .split('\n')
            .filter((l) => /error|Error|ERR!|failed/i.test(l))
            .slice(-25)
            .join('\n');
        const fix = await vscode.window.showWarningMessage(`Build failed — ${tail.split('\n').length} error line(s). Ask agent to fix?`, 'Fix with agent', 'Show log');
        if (fix === 'Show log') {
            const doc = await vscode.workspace.openTextDocument({ content: out, language: 'log' });
            await vscode.window.showTextDocument(doc);
            return;
        }
        if (fix !== 'Fix with agent')
            return;
        progress.report({ message: 'agent analysing errors…' });
        try {
            const r = await post('/builder/chat', {
                mode: 'ask',
                messages: [
                    {
                        role: 'user',
                        content: `npm build failed in this project. Diagnose the root cause and give the concrete fix (file + change). Errors:\n${tail.slice(0, 4000)}`,
                    },
                ],
            }, token);
            const doc = await vscode.workspace.openTextDocument({
                content: r?.data?.html ?? 'no diagnosis',
                language: 'markdown',
            });
            await vscode.window.showTextDocument(doc, { preview: true });
            void vscode.window.showInformationMessage('KUSQO: diagnosis ready — apply the suggested fix');
        }
        catch (err) {
            void vscode.window.showErrorMessage(`Agent diagnosis failed: ${err instanceof Error ? err.message : err}`);
        }
    });
}
let lastCompletionAt = 0;
async function provideInlineCompletion(document, position, context, cancel) {
    const token = context.globalState.get(TOKEN_KEY);
    if (!token)
        return [];
    const now = Date.now();
    if (now - lastCompletionAt < 400)
        return [];
    lastCompletionAt = now;
    const prefix = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
    const last = document.lineAt(document.lineCount - 1);
    const suffix = document.getText(new vscode.Range(position, last.range.end));
    try {
        const res = await post('/ide/complete', { language: document.languageId, prefix, suffix }, token);
        if (cancel.isCancellationRequested)
            return [];
        const text = res?.data?.completion ?? '';
        return text
            ? [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))]
            : [];
    }
    catch {
        return [];
    }
}
function activate(context) {
    context.subscriptions.push(vscode.commands.registerCommand('kusqo.login', () => void login(context)), vscode.commands.registerCommand('kusqo.logout', () => void logout(context)), vscode.commands.registerCommand('kusqo.inlineEdit', () => void inlineEdit(context)), vscode.commands.registerCommand('kusqo.fixVerifyHeal', () => void fixVerifySelfHeal(context)), vscode.commands.registerCommand('kusqo.chat', async () => {
        const token = await getToken(context);
        if (!token) {
            void vscode.window.showWarningMessage('KUSQO: sign in first — the IDE requires an account');
            return;
        }
        agentPanel(context, token);
    }), vscode.commands.registerCommand('kusqo.fixVerify', () => fixVerifyLocal()), vscode.commands.registerCommand('kusqo.preview', () => openPreview()), vscode.commands.registerCommand('kusqo.agent', () => void runAgent(context)), vscode.commands.registerCommand('kusqo.verify', () => void verifyProject(context)), vscode.commands.registerCommand('kusqo.proof', () => {
        const root = workspaceRoot();
        if (root)
            void openProofReport(root);
        else
            void vscode.window.showWarningMessage('Open a project folder first');
    }), vscode.commands.registerCommand('kusqo.memoryRules', () => void generateRules(context)), vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, { provideInlineCompletionItems: (d, p, _c, t) => provideInlineCompletion(d, p, context, t) }));
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    status.text = '$(rocket) KUSQO';
    status.command = 'kusqo.chat';
    status.show();
    context.subscriptions.push(status);
}
