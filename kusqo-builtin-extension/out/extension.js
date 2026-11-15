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
const context_1 = require("./context");
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
async function getJson(path, token) {
    const res = await fetch(`${apiBase()}/api/v1${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const json = (await res.json().catch(() => ({})));
    if (!res.ok)
        throw new Error(json.message ?? `API ${res.status}`);
    return json;
}
function studyMarkdown(url, r) {
    const lines = (items, f) => (items ?? []).map((x) => `- ${f(x)}`).join('\n');
    return [
        `**Site study — ${url}**`,
        `${r.summary ?? ''} (${r.siteType ?? 'unknown type'})`,
        `**Modules**\n${lines(r.modules, (m) => `${m.name} [${m.kind}] — ${m.description}`)}`,
        `**Functions**\n${lines(r.functions, (m) => `${m.name} [${m.kind}] — ${m.description}`)}`,
        `**Backend needed (inferred)**\n${lines(r.inferredBackend, (m) => `${m.capability} (${m.confidence}) — ${m.why}`)}`,
        `**Opportunities**\n${lines(r.opportunities, (m) => `${m.feature} [${m.tier}] — ${m.reason}`)}`,
        `**Not visible to this study**\n${(r.limits ?? []).map((l) => `- ${l}`).join('\n')}`,
        r.openQuestions?.length ? `**Questions to decide**\n${r.openQuestions.map((q) => `- ${q}`).join('\n')}` : '',
    ]
        .filter(Boolean)
        .join('\n\n');
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
#hdr{display:flex;align-items:center;gap:8px;font-family:ui-monospace,Consolas,monospace;padding:8px 12px;border-bottom:1px solid #26263a;font-size:11px;color:#71717a}
#hdr b{letter-spacing:.25em;background:linear-gradient(90deg,#818cf8,#c084fc,#f472b6);-webkit-background-clip:text;background-clip:text;color:transparent;font-size:12px}
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
.meta{font-family:monospace;font-size:11px;color:#71717a}
#chips{display:flex;flex-wrap:wrap;gap:6px;padding:8px 12px 0}
#chips:empty{display:none}
.chip{background:#11111e;border:1px solid #26263a;border-radius:99px;padding:3px 10px;font-size:11px;color:#a5b4fc}
.chip.unsupported{border-color:#92400e;color:#fbbf24}
.chip b{cursor:pointer;color:#71717a}
.review{align-self:stretch;background:#11111e;border:1px solid #26263a;border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:4px}
.rf{display:flex;gap:8px;align-items:center;font:11px monospace;color:#d4d4d8}
.rf input{flex:none;padding:0}
.rf a{margin-left:auto;color:#818cf8;cursor:pointer}
.rbar{display:flex;gap:8px;margin-top:6px}
.rbar .ghost{background:#0b0b14;border:1px solid #26263a;color:#a5b4fc}
#ac{display:none;margin:0 12px;background:#11111e;border:1px solid #26263a;border-radius:8px;max-height:180px;overflow-y:auto}
#ac div{padding:5px 10px;font:11px monospace;color:#d4d4d8;cursor:pointer}
#ac div:hover{background:#26263a}
.starters{display:flex;flex-wrap:wrap;gap:8px;padding:6px 0}
.starters button{background:#11111e;border:1px solid #26263a;color:#a5b4fc;font-weight:500;padding:8px 12px}
.welcome{color:#a1a1aa;line-height:1.6}
#attach{background:#0b0b14;border:1px solid #26263a;color:#a5b4fc;padding:10px 12px}`;
/* eslint-disable no-useless-escape -- injected script text; the escapes are real regex in the child document */
const JS = `const msgs=document.getElementById('msgs');const inp=document.getElementById('inp');
const TRUST=['Read','Suggest','Auto'];let trust=1;let mode='ask';
document.getElementById('mode').onclick=()=>{mode=mode==='ask'?'build':'ask';document.getElementById('mode').textContent='Mode: '+(mode==='ask'?'Ask':'Build');vscode.postMessage({type:'mode',mode:mode})};
document.getElementById('trust').onclick=()=>{trust=(trust+1)%3;document.getElementById('trust').textContent='Trust: '+TRUST[trust];vscode.postMessage({type:'trust',level:trust})};
function md(t){return t.replace(/&/g,'&amp;').replace(/</g,'&lt;')
.replace(/\\*\\*([^*]+)\\*\\*/g,'<b>$1<\\/b>')}
function add(cls,html){const d=document.createElement('div');d.className='m '+cls;d.innerHTML=cls==='u'?html:md(html);msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight;return d}
window.addEventListener('message',(e)=>{const m=e.data;
if(m.type==='user')add('u',m.text);
if(m.type==='plan'){const d=document.createElement('div');d.className='plan';d.innerHTML='◈ '+m.text;msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight}
if(m.type==='stats'){const d=document.createElement('div');d.className='stats';d.textContent=m.text;msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight}
if(m.type==='delta'){const l=document.getElementById('stream')||add('a','');l.id='stream';l.innerHTML=md(m.text);msgs.scrollTop=msgs.scrollHeight}
if(m.type==='done'){const s=document.getElementById('stream');if(s)s.id='';add('a','Preview ready — click Open preview')}
if(m.type==='chips')renderChips(m.items);
if(m.type==='prefill'){inp.value=m.text;document.getElementById('send').click()}
if(m.type==='level'){lvl.textContent='Level: '+(m.level==='beginner'?'Beginner':'Developer')}
if(m.type==='welcome')welcome(m.starters);
if(m.type==='previewOffer'){const d=document.createElement('div');d.className='plan';const b=document.createElement('button');b.textContent='▶ Open preview';b.onclick=()=>vscode.postMessage({type:'openPreview',path:m.path});d.appendChild(b);msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight}
if(m.type==='mentions')showMentions(m.items);
if(m.type==='review'){const d=document.createElement('div');d.className='review';const h=document.createElement('div');h.textContent='Review proposed changes ('+m.files.length+' files) — nothing is written until you apply';h.style.color='#a5b4fc';d.appendChild(h);m.files.forEach((f,i)=>{const r=document.createElement('label');r.className='rf';const c=document.createElement('input');c.type='checkbox';c.checked=f.status!=='same';c.dataset.i=String(i);r.appendChild(c);const t=document.createElement('span');t.textContent=(f.status==='new'?'✚ ':f.status==='same'?'= ':'✎ ')+f.path+'  +'+f.added+' −'+f.removed;r.appendChild(t);const v=document.createElement('a');v.textContent='diff';v.onclick=(e)=>{e.preventDefault();vscode.postMessage({type:'diff',index:i})};r.appendChild(v);d.appendChild(r)});const bar=document.createElement('div');bar.className='rbar';const ap=document.createElement('button');ap.textContent='Apply selected';ap.onclick=()=>{const idx=[...d.querySelectorAll('input')].filter((x)=>x.checked).map((x)=>Number(x.dataset.i));ap.disabled=true;ds.disabled=true;vscode.postMessage({type:'applyReview',indexes:idx})};const ds=document.createElement('button');ds.className='ghost';ds.textContent='Discard';ds.onclick=()=>{ap.disabled=true;ds.disabled=true;vscode.postMessage({type:'discardReview'})};bar.appendChild(ap);bar.appendChild(ds);d.appendChild(bar);msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight}
if(m.type==='studyOffer'){const d=document.createElement('div');d.className='plan';const b=document.createElement('button');b.textContent='▶ Plan my original version';b.onclick=()=>{b.disabled=true;vscode.postMessage({type:'studyPlan'})};d.appendChild(b);const n=document.createElement('span');n.textContent='  structure and functions only — content and branding stay original';d.appendChild(n);msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight}
if(m.type==='revertOffer'){const d=document.createElement('div');d.className='plan';const b=document.createElement('button');b.className='ghost';b.textContent='↩ Revert applied files';b.onclick=()=>{b.disabled=true;vscode.postMessage({type:'revert'})};d.appendChild(b);msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight}
if(m.type==='replay'){msgs.innerHTML='';if(!m.items.length&&m.starters)welcome(m.starters);m.items.forEach((it)=>{if(it.role==='u')add('u',it.text);else if(it.role==='a')add('a',it.text);else{const d=document.createElement('div');d.className=it.role==='plan'?'plan':'stats';d.textContent=it.text;msgs.appendChild(d)}});msgs.scrollTop=msgs.scrollHeight}
if(m.type==='answer'){const l=document.getElementById('stream')||add('a','');l.id='stream';l.innerHTML=md(m.text);msgs.scrollTop=msgs.scrollHeight}
if(m.type==='answerDone'){const q=document.getElementById('stream');if(q)q.id=''}
if(m.type==='proposal'){const d=document.createElement('div');d.className='plan';const b=document.createElement('button');b.textContent='✓ Approve & build in workspace';b.onclick=()=>{b.disabled=true;vscode.postMessage({type:'approve'})};d.appendChild(b);const n=document.createElement('span');n.textContent='  or reply to adjust the plan';d.appendChild(n);msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight}
if(m.type==='error')add('a','⚠ '+m.text)});
const chips=document.getElementById('chips');
document.getElementById('attach').onclick=()=>vscode.postMessage({type:'attach'});
function renderChips(items){chips.innerHTML='';items.forEach((it,i)=>{const sp=document.createElement('span');sp.className='chip '+it.kind;sp.textContent=(it.kind==='unsupported'?'⚠ ':'📎 ')+it.name;sp.title=it.note||'';const x=document.createElement('b');x.textContent=' ×';x.onclick=()=>vscode.postMessage({type:'detach',index:i});sp.appendChild(x);chips.appendChild(sp)})}
document.getElementById('send').onclick=()=>{const v=inp.value.trim();if(!v)return;inp.value='';vscode.postMessage({type:'send',text:v})};
inp.addEventListener('keydown',(e)=>{if(e.key==='Enter')document.getElementById('send').click()});
const lvl=document.getElementById('level');
lvl.onclick=()=>vscode.postMessage({type:'level'});
function welcome(starters){const w=document.createElement('div');w.className='welcome';w.innerHTML='<b>What do you want to do?</b><br>Pick a starting point, or just describe it. Nothing is written to your project until you approve it.';const row=document.createElement('div');row.className='starters';starters.forEach((st)=>{const b=document.createElement('button');b.textContent=st.label;b.onclick=()=>{if(st.id==='form'){vscode.postMessage({type:'attach'})}inp.value=st.text;inp.focus()};row.appendChild(b)});w.appendChild(row);msgs.appendChild(w)}
const ac=document.getElementById('ac');
function atToken(){const m=/(?:^|\\s)@([\\w./\\\\-]*)$/.exec(inp.value);return m?m[1]:null}
inp.addEventListener('input',()=>{const q=atToken();if(q===null){ac.style.display='none';return}vscode.postMessage({type:'mentionQuery',q:q})});
function showMentions(items){ac.innerHTML='';if(!items.length){ac.style.display='none';return}items.forEach((p)=>{const d=document.createElement('div');d.textContent=p;d.onclick=()=>{inp.value=inp.value.replace(/@[\\w./\\\\-]*$/,'@'+p+' ');ac.style.display='none';inp.focus()};ac.appendChild(d)});ac.style.display='block'}
vscode.postMessage({type:'ready'});`;
const IMAGE_MIME = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
};
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 30_000;
const MAX_ATTACHMENTS = 6;
async function readAttachment(uri) {
    const name = uri.path.split('/').pop() ?? 'file';
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (IMAGE_MIME[ext]) {
        if (bytes.byteLength > MAX_IMAGE_BYTES)
            return { name, kind: 'unsupported', note: 'Image larger than 2 MB — resize or crop it' };
        return {
            name,
            kind: 'image',
            url: `data:${IMAGE_MIME[ext]};base64,${Buffer.from(bytes).toString('base64')}`,
        };
    }
    if (bytes.subarray(0, 8000).includes(0))
        return {
            name,
            kind: 'unsupported',
            note: `.${ext || 'binary'} files cannot be read yet — export to PDF/text/CSV/JSON or attach a photo/screenshot of it`,
        };
    const full = Buffer.from(bytes).toString('utf8');
    const truncated = full.length > MAX_TEXT_CHARS;
    return {
        name,
        kind: 'text',
        text: truncated ? full.slice(0, MAX_TEXT_CHARS) : full,
        note: truncated ? `Truncated to the first ${MAX_TEXT_CHARS} characters` : undefined,
    };
}
function attachmentContext(items) {
    const fence = '`'.repeat(3);
    return items
        .filter((a) => a.kind === 'text')
        .map((a) => `[Attached file: ${a.name}${a.note ? ` — ${a.note}` : ''}]\n${fence}\n${a.text}\n${fence}`)
        .join('\n\n');
}
const ANALYSIS_INSTRUCTION = '[ANALYSIS ONLY — do NOT write code or files yet. Study every attached image/file carefully ' +
    '(multiple items are parts of one document or project). Report: 1) what it is and its purpose; ' +
    '2) its structure — sections, fields, labels, options, tables, signatures, dates, data — marking ' +
    'anything illegible or uncertain; 3) rules/validation you infer; 4) a concrete proposal of what ' +
    'you would build or change in this workspace; 5) the questions you need answered. ' +
    'End by asking the user to approve the plan.]';
async function streamChatRequest(token, body, onDelta) {
    const res = await fetch(`${apiBase()}/api/v1/builder/chat/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });
    if (!res.ok || !res.body)
        throw new Error(`Stream ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let acc = '';
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
            let ev;
            try {
                ev = JSON.parse(line.slice(5).trim());
            }
            catch {
                continue;
            }
            if (ev.type === 'error')
                throw new Error(ev.message ?? 'Stream failed');
            const delta = ev.text ?? ev.content;
            if (ev.type === 'delta' && delta) {
                acc += delta;
                onDelta(acc);
            }
            if (ev.type === 'done')
                return { html: ev.html ?? acc, files: ev.files };
        }
    }
    throw new Error('Stream ended without a result');
}
const PROPOSED_SCHEME = 'kusqo-proposed';
const proposedDocs = new Map();
class ProposedContent {
    provideTextDocumentContent(uri) {
        return proposedDocs.get(uri.path) ?? '';
    }
}
function lineDiffStat(before, after) {
    const b = new Set(before.split('\n'));
    const a = new Set(after.split('\n'));
    let added = 0;
    let removed = 0;
    for (const l of a)
        if (!b.has(l))
            added++;
    for (const l of b)
        if (!a.has(l))
            removed++;
    return { added, removed };
}
function safeRelPath(p) {
    const rel = p.replace(/^[\\/]+/, '');
    return rel && !rel.split(/[\\/]/).includes('..') ? rel : null;
}
async function buildReview(files) {
    const root = workspaceRoot();
    if (!root)
        throw new Error('Open a project folder first — nothing can be reviewed or written');
    const out = [];
    for (const f of files) {
        const rel = safeRelPath(f.path);
        if (!rel)
            continue;
        let before = null;
        try {
            before = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(`${root}/${rel}`))).toString('utf8');
        }
        catch {
            before = null;
        }
        out.push({
            path: rel,
            content: f.content,
            status: before === null ? 'new' : before === f.content ? 'same' : 'modified',
            ...(before === null
                ? { added: f.content.split(/\r?\n/).length, removed: 0 }
                : lineDiffStat(before, f.content)),
        });
    }
    return out;
}
async function showProposedDiff(file) {
    const root = workspaceRoot();
    if (!root)
        return;
    proposedDocs.set(`/${file.path}`, file.content);
    proposedDocs.set(`/empty/${file.path}`, '');
    const right = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: `/${file.path}` });
    const left = file.status === 'new'
        ? vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: `/empty/${file.path}` })
        : vscode.Uri.file(`${root}/${file.path}`);
    await vscode.commands.executeCommand('vscode.diff', left, right, `${file.path} — proposed change`);
}
async function writeReviewed(files) {
    const root = workspaceRoot();
    if (!root)
        throw new Error('Open a project folder first — nothing was written');
    const snap = await snapshotFiles(root, files.map((f) => f.path));
    for (const f of files) {
        const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
        if (dir)
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(`${root}/${dir}`));
        await vscode.workspace.fs.writeFile(vscode.Uri.file(`${root}/${f.path}`), Buffer.from(f.content, 'utf8'));
    }
    return snap;
}
// ---------- Repo context: local index + @-mentions + automatic retrieval ----------
const INDEX_EXCLUDE = '**/{node_modules,.git,dist,out,build,.next,coverage,target,vendor,__pycache__,.venv}/**';
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|exe|dll|so|woff2?|ttf|mp[34]|lock|vsix|map)$/i;
const MAX_INDEX_FILES = 1500;
const MAX_INDEX_BYTES = 200_000;
const MAX_CONTEXT_CHARS = 30_000;
const repoIndex = { entries: new Map(), paths: [], ready: false };
function relPath(uri) {
    return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
}
async function ensureIndex() {
    if (repoIndex.ready || !workspaceRoot())
        return;
    const uris = (await vscode.workspace.findFiles('**/*', INDEX_EXCLUDE, 4000)).filter((u) => !BINARY_EXT.test(u.path));
    repoIndex.paths = uris.map(relPath).sort();
    repoIndex.entries.clear();
    for (const uri of uris.slice(0, MAX_INDEX_FILES)) {
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            if (bytes.byteLength > MAX_INDEX_BYTES || bytes.subarray(0, 4000).includes(0))
                continue;
            const rel = relPath(uri);
            repoIndex.entries.set(rel, (0, context_1.buildEntry)(rel, Buffer.from(bytes).toString('utf8')));
        }
        catch {
            /* unreadable — skip */
        }
    }
    repoIndex.ready = true;
}
function watchRepo(context) {
    const reset = () => {
        repoIndex.ready = false;
    };
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => {
        if (BINARY_EXT.test(doc.uri.path))
            return;
        const rel = relPath(doc.uri);
        if (repoIndex.ready && doc.getText().length <= MAX_INDEX_BYTES)
            repoIndex.entries.set(rel, (0, context_1.buildEntry)(rel, doc.getText()));
    }), vscode.workspace.onDidCreateFiles(reset), vscode.workspace.onDidDeleteFiles(reset), vscode.workspace.onDidRenameFiles(reset));
}
async function gatherContext(text, auto) {
    const out = { block: '', used: [], missing: [] };
    if (!workspaceRoot())
        return out;
    await ensureIndex();
    const fence = '`'.repeat(3);
    const parts = [];
    let total = 0;
    const add = (path, body) => {
        if (out.used.includes(path) || total + body.length > MAX_CONTEXT_CHARS)
            return;
        total += body.length;
        out.used.push(path);
        parts.push(`[Context: ${path}]\n${fence}\n${body}\n${fence}`);
    };
    const mentions = (0, context_1.parseMentions)(text);
    for (const m of mentions) {
        const target = (0, context_1.resolveMention)(m, repoIndex.paths);
        if (target.kind === 'none')
            out.missing.push(m);
        for (const p of target.paths) {
            const entry = repoIndex.entries.get(p);
            if (entry)
                add(p, (0, context_1.snippetFor)(entry.text, text, 8000));
        }
    }
    const wantsCodebase = /@codebase/i.test(text);
    if (wantsCodebase || (auto && mentions.length === 0)) {
        const files = [...repoIndex.entries.values()];
        for (const r of (0, context_1.rank)(files, text, wantsCodebase ? 6 : 4)) {
            const entry = repoIndex.entries.get(r.path);
            if (entry)
                add(r.path, (0, context_1.snippetFor)(entry.text, text, 2500));
        }
    }
    out.block = parts.join('\n\n');
    return out;
}
function getLevel() {
    return vscode.workspace.getConfiguration('kusqo').get('experience', 'beginner');
}
const PLAIN_HINT = '[The user is a beginner: answer in plain language, define any technical term you must use, keep steps short and say what each file is for.]';
const PLAN_INSTRUCTION = '[PLAN ONLY — do NOT write code or files yet. Propose in plain language: 1) what you will build and how the user will use it; ' +
    '2) the stack and the files you will create; 3) what you need from the user (content, accounts, keys); ' +
    '4) the questions that would change the result. End by asking the user to approve the plan.]';
async function openWorkspacePreview(rel) {
    const root = workspaceRoot();
    if (!root)
        return;
    const rootUri = vscode.Uri.file(root);
    const fileUri = vscode.Uri.file(`${root}/${rel}`);
    const panel = vscode.window.createWebviewPanel('kusqoSitePreview', `Preview — ${rel}`, vscode.ViewColumn.Beside, {
        enableScripts: true,
        localResourceRoots: [rootUri],
    });
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
    const base = `${panel.webview.asWebviewUri(vscode.Uri.file(`${root}/${dir}`))}/`;
    let doc = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString('utf8');
    const tag = `<base href="${base}">`;
    doc = /<head[^>]*>/i.test(doc) ? doc.replace(/<head[^>]*>/i, (m) => `${m}${tag}`) : `${tag}${doc}`;
    panel.webview.html = doc;
}
const STARTERS = [
    { id: 'site', label: 'Build a website', text: 'Build a modern website for ' },
    { id: 'form', label: 'Digitize a paper form', text: 'Turn the attached form into a digital form with a records register and PDF download' },
    { id: 'api', label: 'Create an API', text: 'Create a REST API with a database for ' },
    { id: 'explain', label: 'Explain this project', text: '@codebase Explain what this project does and how it is organized' },
    { id: 'fix', label: 'Check & fix errors', text: 'Run the checks on this project and explain any problem you find' },
];
const CHAT_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${CSS}</style></head>
    <body><div id="hdr"><svg width="18" height="18" viewBox="0 0 48 48" fill="none"><defs><linearGradient id="kqg" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#818cf8"/><stop offset="55%" stop-color="#c084fc"/><stop offset="100%" stop-color="#f472b6"/></linearGradient></defs><polygon points="24,4 41,14 41,34 24,44 7,34 7,14" stroke="url(#kqg)" stroke-width="2.5" stroke-linejoin="round"/><path d="M18 15v18M18 24l10-9M18 24l10 9" stroke="url(#kqg)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg><b>KUSQO</b><span id="modeLbl">build verified.</span><button id="level" title="Beginner: plain language, plan before building · Developer: concise, direct">Level: Beginner</button><button id="mode" title="Ask = answers only · Build = writes code">Mode: Ask</button><button id="trust" title="Agent autonomy">Trust: Suggest</button></div>
    <div id="msgs"></div><div id="chips"></div><div id="ac"></div><div id="bar"><button id="attach" title="Attach images or files — analyzed before anything is built">📎</button><input id="inp" placeholder="Ask, or describe what to build — @file for context…"/><button id="send">Send</button></div>
    <script>const vscode=acquireVsCodeApi();${JS}</script></body></html>`;
class KusqoChatView {
    context;
    static viewType = 'kusqo.agentView';
    constructor(context) {
        this.context = context;
    }
    resolveWebviewView(view) {
        view.webview.options = { enableScripts: true };
        view.webview.html = CHAT_HTML;
        mountChat(this.context, view.webview);
    }
}
function mountChat(context, webview) {
    const LOG_KEY = 'kusqo.chatLog';
    let log = context.workspaceState.get(LOG_KEY) ?? [];
    const remember = (item) => {
        log = [...log, item].slice(-200);
        void context.workspaceState.update(LOG_KEY, log);
    };
    const ensureToken = async () => {
        let t = await getToken(context);
        if (!t)
            t = await login(context);
        if (!t)
            throw new Error('Sign in to KUSQO first (Command Palette: KUSQO: Login)');
        return t;
    };
    let html = '';
    let trustLevel = 1; // 0 Read · 1 Suggest · 2 Auto
    let chatMode = 'ask';
    let reviewFiles = [];
    let lastSnap = null;
    let pending = [];
    let proposal = null;
    const send = (m) => void webview.postMessage(m);
    const showChips = () => send({ type: 'chips', items: pending.map(({ name, kind, note }) => ({ name, kind, note })) });
    const toImages = (items) => items.filter((a) => a.kind === 'image').map((a) => ({ url: a.url ?? '', name: a.name }));
    async function readPdf(uri) {
        const name = uri.path.split('/').pop() ?? 'file.pdf';
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (bytes.byteLength > 5 * 1024 * 1024)
            return { name, kind: 'unsupported', note: 'PDF larger than 5 MB' };
        const res = await post('/builder/attachments/extract', { name, data: Buffer.from(bytes).toString('base64') }, await ensureToken());
        if (!res.data?.hasTextLayer)
            return { name, kind: 'unsupported', note: 'No selectable text (scanned PDF) — attach a photo or screenshot of it instead' };
        return { name, kind: 'text', text: res.data.text.slice(0, MAX_TEXT_CHARS) };
    }
    async function attachFiles() {
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: 'Attach to KUSQO',
            title: 'Attach images, PDFs or text files (unreadable ones are flagged)',
        });
        for (const uri of picked ?? []) {
            if (pending.length >= MAX_ATTACHMENTS)
                break;
            try {
                pending.push(uri.path.toLowerCase().endsWith('.pdf') ? await readPdf(uri) : await readAttachment(uri));
            }
            catch (err) {
                pending.push({ name: uri.path.split('/').pop() ?? 'file', kind: 'unsupported', note: String(err) });
            }
        }
        showChips();
    }
    async function analyze(text) {
        const usable = pending.filter((a) => a.kind !== 'unsupported');
        const skipped = pending.filter((a) => a.kind === 'unsupported');
        pending = [];
        showChips();
        if (!usable.length && skipped.length) {
            send({
                type: 'error',
                text: `None of the attached files could be read: ${skipped.map((a) => `${a.name} (${a.note})`).join('; ')}`,
            });
            return;
        }
        if (skipped.length)
            send({ type: 'plan', text: `Skipped (unreadable): ${skipped.map((a) => a.name).join(', ')}` });
        const rules = await readRules();
        const rulesBlock = rules ? `\n\n[Project rules]\n${rules.slice(0, 1500)}` : '';
        const gathered = await gatherContext(text, true);
        const instruction = usable.length ? ANALYSIS_INSTRUCTION : PLAN_INSTRUCTION;
        const beginner = getLevel() === 'beginner' ? `\n\n${PLAIN_HINT}` : '';
        const prompt = [text, attachmentContext(usable), gathered.block, instruction].filter(Boolean).join('\n\n') + beginner + rulesBlock;
        const images = toImages(usable);
        const out = await streamChatRequest(await ensureToken(), {
            messages: [{ role: 'user', content: prompt }],
            mode: 'ask',
            ...(images.length ? { attachments: images } : {}),
        }, (acc) => send({ type: 'answer', text: acc }));
        send({ type: 'answer', text: out.html });
        send({ type: 'answerDone' });
        remember({ role: 'a', text: out.html });
        proposal = { instruction: text, items: usable, rules };
        send({ type: 'proposal' });
    }
    async function generateAndReview(content, images) {
        const out = await streamChatRequest(await ensureToken(), {
            messages: [{ role: 'user', content }],
            mode: 'build',
            projectType: 'module',
            ...(images.length ? { attachments: images } : {}),
        }, () => undefined);
        if (out.files?.length) {
            send({ type: 'stats', text: `${out.files.length} file(s) generated` });
            remember({ role: 'stats', text: `${out.files.length} file(s) generated` });
            reviewFiles = await buildReview(out.files);
            send({
                type: 'review',
                files: reviewFiles.map(({ path, status, added, removed }) => ({ path, status, added, removed })),
            });
        }
        else if (out.html) {
            html = out.html;
            send({ type: 'done' });
        }
        else
            send({ type: 'error', text: 'No files returned' });
    }
    async function buildApproved() {
        if (!proposal)
            return;
        const p = proposal;
        proposal = null;
        send({ type: 'plan', text: 'Approved — generating the project…' });
        const images = toImages(p.items);
        const content = `Approved. Build exactly what was proposed for: ${p.instruction}\n` +
            'Use the attached material as the source of truth.\n\n' +
            attachmentContext(p.items) +
            (p.rules ? `\n\n[Project rules]\n${p.rules.slice(0, 1500)}` : '');
        await generateAndReview(content, images);
    }
    async function applyReview(indexes) {
        const sel = indexes.map((i) => reviewFiles[i]).filter((f) => f && f.status !== 'same');
        if (!sel.length) {
            send({ type: 'error', text: 'No changed files selected — nothing was written' });
            return;
        }
        lastSnap = await writeReviewed(sel);
        reviewFiles = [];
        const written = `${sel.length} file(s) written to the workspace`;
        send({ type: 'stats', text: written });
        remember({ role: 'stats', text: written });
        const entry = sel.find((f) => f.path === 'index.html') ?? sel.find((f) => f.path.endsWith('/index.html'));
        if (entry)
            send({ type: 'previewOffer', path: entry.path });
        if (!vscode.workspace.getConfiguration('kusqo').get('autoVerify', true)) {
            send({ type: 'revertOffer' });
            return;
        }
        send({ type: 'plan', text: 'Verifying the result…' });
        const report = await verifyProject(context);
        const verdict = report?.verdict ?? 'not run';
        const line = verdict === 'verified' ? '✓ Verified — build, tests and checks passed' : `Verification: ${verdict}`;
        send({ type: verdict === 'verified' ? 'stats' : 'plan', text: line });
        remember({ role: verdict === 'verified' ? 'stats' : 'plan', text: line });
        if (verdict !== 'verified')
            send({ type: 'revertOffer' });
    }
    async function revertLast() {
        const root = workspaceRoot();
        if (!root || !lastSnap)
            return;
        await restoreSnapshot(root, lastSnap);
        lastSnap = null;
        send({ type: 'stats', text: 'Changes reverted' });
        remember({ role: 'stats', text: 'Changes reverted' });
    }
    let study = null;
    async function runStudy(rawUrl) {
        const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
        const ok = await vscode.window.showWarningMessage(`Study ${url}?`, {
            modal: true,
            detail: 'KUSQO will read the public pages of this site (respecting robots.txt) and describe its structure, modules and functions. ' +
                'You confirm that you have the right to study it and that what you build from it is your responsibility. ' +
                'Only structure and functions are reused — text, images and branding must be original.',
        }, 'I confirm — study the site');
        if (!ok) {
            send({ type: 'plan', text: 'Site study cancelled — nothing was fetched' });
            return;
        }
        const token = await ensureToken();
        const started = await post('/builder/site-study', { url, attested: true }, token);
        send({ type: 'plan', text: `Studying ${url}…` });
        let lastProgress = '';
        for (let i = 0; i < 150; i++) {
            await new Promise((r) => setTimeout(r, i === 0 ? 1200 : 2500));
            const res = await getJson(`/builder/site-study/${started.data.id}`, token);
            const d = res.data;
            if (d.progress && d.progress !== lastProgress) {
                lastProgress = d.progress;
                send({ type: 'plan', text: d.progress });
            }
            if (d.status === 'failed')
                throw new Error(d.error ?? 'Site study failed');
            if (d.status === 'done' && d.report) {
                const md = studyMarkdown(url, d.report);
                study = { url, markdown: md };
                send({ type: 'answer', text: md });
                send({ type: 'answerDone' });
                remember({ role: 'a', text: md });
                send({ type: 'studyOffer' });
                return;
            }
        }
        throw new Error('The site study is taking too long — check back later');
    }
    async function planFromStudy() {
        if (!study)
            return;
        const text = `Plan an ORIGINAL product similar in structure and function to ${study.url}. Reuse modules and flows, never its text, images or branding.`;
        pending = [{ name: 'site-study.md', kind: 'text', text: study.markdown }];
        send({ type: 'user', text });
        remember({ role: 'u', text });
        await analyze(text);
    }
    async function plainChat(text) {
        const ed = vscode.window.activeTextEditor;
        let promptText = text;
        if (ed && /@file|@sel|@code/i.test(text)) {
            const code = ed.selection.isEmpty
                ? ed.document.getText().slice(0, 6000)
                : ed.document.getText(ed.selection).slice(0, 6000);
            promptText = `${text}\n\n[${vscode.workspace.asRelativePath(ed.document.uri)}]\n${code}`;
        }
        const rules = await readRules();
        if (rules)
            promptText += `\n\n[Project rules]\n${rules.slice(0, 1500)}`;
        const auto = chatMode === 'ask' && vscode.workspace.getConfiguration('kusqo').get('autoContext', true);
        const gathered = await gatherContext(text, auto);
        if (gathered.block)
            promptText += `\n\n${gathered.block}`;
        if (gathered.used.length || gathered.missing.length) {
            const note = (gathered.used.length ? `Context: ${gathered.used.join(', ')}` : '') +
                (gathered.missing.length ? `${gathered.used.length ? ' · ' : ''}not found: ${gathered.missing.map((m) => `@${m}`).join(', ')}` : '');
            send({ type: 'plan', text: note });
            remember({ role: 'plan', text: note });
        }
        if (trustLevel === 0)
            promptText = `${promptText}\n\n[TRUST:READ — explain only, do NOT modify anything]`;
        if (chatMode === 'ask') {
            if (getLevel() === 'beginner')
                promptText += `\n\n${PLAIN_HINT}`;
            const out = await streamChatRequest(await ensureToken(), { messages: [{ role: 'user', content: promptText }], mode: 'ask' }, (acc) => send({ type: 'answer', text: acc }));
            send({ type: 'answer', text: out.html });
            send({ type: 'answerDone' });
            remember({ role: 'a', text: out.html });
            return;
        }
        send({ type: 'plan', text: 'Generating the project…' });
        await generateAndReview(promptText, []);
    }
    webview.onDidReceiveMessage(async (msg) => {
        try {
            if (msg.type === 'ready') {
                send({ type: 'level', level: getLevel() });
                send({ type: 'replay', items: log, starters: STARTERS });
            }
            else if (msg.type === 'diff' && msg.index !== undefined)
                await showProposedDiff(reviewFiles[msg.index]);
            else if (msg.type === 'applyReview')
                await applyReview(msg.indexes ?? []);
            else if (msg.type === 'discardReview') {
                reviewFiles = [];
                send({ type: 'plan', text: 'Proposed changes discarded — nothing was written' });
            }
            else if (msg.type === 'revert')
                await revertLast();
            else if (msg.type === 'level') {
                const next = getLevel() === 'beginner' ? 'developer' : 'beginner';
                await vscode.workspace.getConfiguration('kusqo').update('experience', next, vscode.ConfigurationTarget.Global);
                send({ type: 'level', level: next });
            }
            else if (msg.type === 'openPreview' && msg.path)
                await openWorkspacePreview(msg.path);
            else if (msg.type === 'studyPlan')
                await planFromStudy();
            else if (msg.type === 'mentionQuery') {
                await ensureIndex();
                send({ type: 'mentions', items: (0, context_1.completeMention)(msg.q ?? '', repoIndex.paths) });
            }
            else if (msg.type === 'mode')
                chatMode = msg.mode === 'build' ? 'build' : 'ask';
            else if (msg.type === 'trust')
                trustLevel = msg.level ?? 1;
            else if (msg.type === 'attach')
                await attachFiles();
            else if (msg.type === 'detach') {
                pending = pending.filter((_, i) => i !== msg.index);
                showChips();
            }
            else if (msg.type === 'approve')
                await buildApproved();
            else if (msg.type === 'send' && msg.text) {
                const cmd = /^\/study\s+(\S+)/i.exec(msg.text);
                if (cmd) {
                    send({ type: 'user', text: msg.text });
                    remember({ role: 'u', text: msg.text });
                    await runStudy(cmd[1]);
                    return;
                }
                const names = pending.map((a) => a.name).join(', ');
                const shown = names ? `${msg.text}\n📎 ${names}` : msg.text;
                send({ type: 'user', text: shown });
                remember({ role: 'u', text: shown });
                proposal = null;
                if (pending.length || (chatMode === 'build' && getLevel() === 'beginner'))
                    await analyze(msg.text);
                else
                    await plainChat(msg.text);
            }
        }
        catch (err) {
            send({ type: 'error', text: err instanceof Error ? err.message : String(err) });
        }
    });
    chatControl.queue = (text) => {
        void webview.postMessage({ type: 'prefill', text });
    };
    chatControl.clear = () => {
        log = [];
        void context.workspaceState.update(LOG_KEY, []);
        send({ type: 'replay', items: [], starters: STARTERS });
    };
    // expose current html for preview command
    void context.workspaceState.update('kusqo.lastHtml', '');
    lastHtmlRef.html = () => html;
}
const chatControl = { clear: () => undefined, queue: () => undefined };
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
    context.subscriptions.push(vscode.commands.registerCommand('kusqo.login', () => void login(context)), vscode.commands.registerCommand('kusqo.logout', () => void logout(context)), vscode.commands.registerCommand('kusqo.inlineEdit', () => void inlineEdit(context)), vscode.commands.registerCommand('kusqo.fixVerifyHeal', () => void fixVerifySelfHeal(context)), vscode.window.registerWebviewViewProvider(KusqoChatView.viewType, new KusqoChatView(context), {
        webviewOptions: { retainContextWhenHidden: true },
    }), vscode.commands.registerCommand('kusqo.chat', () => vscode.commands.executeCommand('kusqo.agentView.focus')), vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, new ProposedContent()), vscode.commands.registerCommand('kusqo.newChat', () => chatControl.clear()), vscode.commands.registerCommand('kusqo.studySite', async () => {
        const url = await vscode.window.showInputBox({ prompt: 'Website to study (structure and functions only)', placeHolder: 'https://example.com', ignoreFocusOut: true });
        if (!url)
            return;
        await vscode.commands.executeCommand('kusqo.agentView.focus');
        chatControl.queue(`/study ${url.trim()}`);
    }), vscode.commands.registerCommand('kusqo.fixVerify', () => fixVerifyLocal()), vscode.commands.registerCommand('kusqo.preview', () => openPreview()), vscode.commands.registerCommand('kusqo.agent', () => void runAgent(context)), vscode.commands.registerCommand('kusqo.verify', () => void verifyProject(context)), vscode.commands.registerCommand('kusqo.proof', () => {
        const root = workspaceRoot();
        if (root)
            void openProofReport(root);
        else
            void vscode.window.showWarningMessage('Open a project folder first');
    }), vscode.commands.registerCommand('kusqo.memoryRules', () => void generateRules(context)), vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, { provideInlineCompletionItems: (d, p, _c, t) => provideInlineCompletion(d, p, context, t) }));
    watchRepo(context);
    if (!context.globalState.get('kusqo.welcomed')) {
        void context.globalState.update('kusqo.welcomed', true);
        void vscode.commands.executeCommand('workbench.action.openWalkthrough', 'kusqo.kusqo-ide#kusqo.welcome', false);
    }
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    status.text = '$(rocket) KUSQO';
    status.command = 'kusqo.chat';
    status.show();
    context.subscriptions.push(status);
}
