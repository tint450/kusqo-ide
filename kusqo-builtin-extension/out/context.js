"use strict";
/**
 * Local, dependency-free repo context: BM25-style retrieval over workspace files
 * plus @-mention parsing/resolution. No vscode imports — unit-testable in plain Node.
 * No embeddings: ranking is lexical (identifiers, paths, words), which is honest
 * about what it can and cannot find (it does not understand synonyms).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RESERVED_MENTIONS = void 0;
exports.tokenize = tokenize;
exports.buildEntry = buildEntry;
exports.rank = rank;
exports.snippetFor = snippetFor;
exports.parseMentions = parseMentions;
exports.resolveMention = resolveMention;
exports.completeMention = completeMention;
exports.RESERVED_MENTIONS = ['file', 'sel', 'code', 'codebase'];
const STOP = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'what', 'how', 'why', 'does', 'are',
    'was', 'you', 'can', 'not', 'all', 'any', 'use', 'used', 'using', 'where', 'which', 'when', 'have',
    'has', 'make', 'need', 'want', 'please', 'show', 'tell', 'about', 'there', 'their', 'then',
    'const', 'let', 'var', 'function', 'return', 'import', 'export', 'default', 'class', 'new', 'true', 'false', 'null',
]);
function tokenize(s) {
    const out = [];
    for (const word of s.split(/[^A-Za-z0-9_]+/)) {
        if (word.length < 3)
            continue;
        const parts = word
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .split(/[\s_]+/)
            .map((p) => p.toLowerCase())
            .filter((p) => p.length >= 3 && !STOP.has(p));
        for (const p of parts)
            out.push(p);
        const whole = word.toLowerCase();
        if (parts.length > 1 && !STOP.has(whole))
            out.push(whole);
    }
    return out;
}
function buildEntry(path, text) {
    const tf = new Map();
    const tokens = tokenize(text);
    for (const t of tokens)
        tf.set(t, (tf.get(t) ?? 0) + 1);
    return { path, text, tf, len: tokens.length || 1, pathTokens: new Set(tokenize(path.replace(/[\\/.]/g, ' '))) };
}
function rank(files, query, k = 5) {
    const q = [...new Set(tokenize(query))];
    if (!q.length || !files.length)
        return [];
    const N = files.length;
    const avg = files.reduce((n, f) => n + f.len, 0) / N;
    const df = new Map();
    for (const t of q)
        df.set(t, files.reduce((n, f) => n + (f.tf.has(t) ? 1 : 0), 0));
    const scored = [];
    for (const f of files) {
        let score = 0;
        for (const t of q) {
            const n = df.get(t) ?? 0;
            const tf = f.tf.get(t) ?? 0;
            if (tf) {
                const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
                score += idf * ((tf * 2.5) / (tf + 1.5 * (0.25 + (0.75 * f.len) / avg)));
            }
            if (f.pathTokens.has(t))
                score += 2;
        }
        if (score > 0)
            scored.push({ path: f.path, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, k);
}
/** A readable excerpt: the lines around the densest matches, in file order. */
function snippetFor(text, query, maxChars = 2500) {
    const lines = text.split('\n');
    if (text.length <= maxChars)
        return text;
    const q = new Set(tokenize(query));
    const hits = [];
    lines.forEach((l, i) => {
        if (tokenize(l).some((t) => q.has(t)))
            hits.push(i);
    });
    const keep = new Set();
    for (const h of hits.slice(0, 8))
        for (let i = Math.max(0, h - 4); i <= Math.min(lines.length - 1, h + 6); i++)
            keep.add(i);
    if (!keep.size)
        for (let i = 0; i < Math.min(lines.length, 40); i++)
            keep.add(i);
    let out = '';
    let prev = -2;
    for (const i of [...keep].sort((a, b) => a - b)) {
        if (i !== prev + 1)
            out += '…\n';
        out += `${lines[i]}\n`;
        prev = i;
        if (out.length > maxChars)
            break;
    }
    return out.slice(0, maxChars);
}
function parseMentions(text) {
    const out = [];
    for (const m of text.matchAll(/(?:^|\s)@([\w./\\-]+)/g)) {
        const tok = m[1].replace(/[.,;:]+$/, '');
        if (!exports.RESERVED_MENTIONS.includes(tok.toLowerCase()) && !out.includes(tok))
            out.push(tok);
    }
    return out;
}
function resolveMention(token, paths, maxFolderFiles = 8) {
    const t = token.replace(/\\/g, '/').replace(/^\.?\//, '');
    const exact = paths.find((p) => p === t);
    if (exact)
        return { kind: 'file', paths: [exact] };
    const suffix = paths.filter((p) => p.endsWith(`/${t}`));
    if (suffix.length === 1)
        return { kind: 'file', paths: suffix };
    if (suffix.length > 1)
        return { kind: 'file', paths: suffix.slice(0, 3) };
    const dir = t.replace(/\/$/, '');
    const inDir = paths.filter((p) => p.startsWith(`${dir}/`) || p.includes(`/${dir}/`));
    if (inDir.length)
        return { kind: 'folder', paths: inDir.slice(0, maxFolderFiles) };
    return { kind: 'none', paths: [] };
}
/** Case-insensitive path completion for the @ dropdown. */
function completeMention(q, paths, limit = 8) {
    const needle = q.toLowerCase().replace(/\\/g, '/');
    if (!needle)
        return paths.slice(0, limit);
    const scored = paths
        .map((p) => {
        const lp = p.toLowerCase();
        const base = lp.slice(lp.lastIndexOf('/') + 1);
        const s = base.startsWith(needle) ? 3 : base.includes(needle) ? 2 : lp.includes(needle) ? 1 : 0;
        return { p, s };
    })
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || a.p.length - b.p.length);
    return scored.slice(0, limit).map((x) => x.p);
}
