#!/usr/bin/env node
/**
 * ClaudeManager — ローカルサーバー
 * ~/.claude を読み（スキル/プロジェクト/サブエージェント/統計）、GUIで表示・編集する。
 *
 * 起動:
 *   npx claude-manager                 # localhost のみ（安全・既定）
 *   npx claude-manager --host :: --open # LAN/Tailscaleに公開（トークン自動発行）
 *   オプション: --port <n> --host <addr> --token <str> --open
 */
import express from "express";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { exec as _exec } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, ".claude");

// ── CLI引数 ──
function arg(name, def) {
    const i = process.argv.indexOf(`--${name}`);
    if (i === -1) return def;
    const v = process.argv[i + 1];
    return (v && !v.startsWith("--")) ? v : true;
}
const PORT = Number(arg("port", 4317));
const HOST = arg("host", "127.0.0.1");           // 既定はループバック（安全）
const OPEN = !!arg("open", false);
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];
const isRemoteExposed = !LOOPBACK_HOSTS.includes(HOST);
// 公開時はトークン必須。未指定なら自動発行。
let TOKEN = arg("token", null);
if (isRemoteExposed && !TOKEN) TOKEN = crypto.randomBytes(12).toString("hex");

function reqIsLoopback(req) {
    const a = (req.socket.remoteAddress || "").replace("::ffff:", "");
    return a === "127.0.0.1" || a === "::1";
}

app.use(express.json({ limit: "5mb" }));

// ── 認証: ループバックは無条件許可。リモートはトークン必須 ──
app.use("/api", (req, res, next) => {
    if (reqIsLoopback(req)) return next();
    if (TOKEN && (req.get("x-cc-token") === TOKEN || req.query.token === TOKEN)) return next();
    return res.status(401).json({ ok: false, error: "リモートアクセスにはトークンが必要です（起動時に表示されたURLを使用してください）" });
});

app.use(express.static(path.join(__dirname, "public")));

/* ───────── ユーティリティ ───────── */

// ごく軽量な frontmatter パーサ（--- 〜 --- の key: value を取り出す）
function parseFrontmatter(text) {
    const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!m) return { data: {}, body: text };
    const data = {};
    let lastKey = null;
    for (const line of m[1].split("\n")) {
        const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
        if (kv) { data[kv[1]] = kv[2].replace(/^["']|["']$/g, ""); lastKey = kv[1]; }
        else if (lastKey && line.trim()) { data[lastKey] += " " + line.trim(); }
    }
    return { data, body: text.slice(m[0].length).trim() };
}

function readSafe(p) { try { return fs.readFileSync(p, "utf8"); } catch { return null; } }
function jsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

// 編集を許可するパス（~/.claude 配下 と プロジェクトのCLAUDE.md のみ）
function isWritable(p) {
    const abs = path.resolve(p);
    if (abs.startsWith(CLAUDE_DIR + path.sep)) return true;
    if (path.basename(abs) === "CLAUDE.md") return true; // プロジェクト直下のCLAUDE.md
    return false;
}

// プロジェクトキー（-Volumes-MacData-...）を実パスへ
function keyToPath(key) {
    // Claude のプロジェクトキーは "/" を "-" に置換したもの。
    // ただしディレクトリ名自体に "-" が含まれると区別できないため、
    // 先頭から greedy に実在するパスを辿って復元する。
    const segs = key.replace(/^-/, "").split("-").filter(Boolean);
    let current = "/";
    let i = 0;
    while (i < segs.length) {
        let matched = false;
        for (let len = segs.length - i; len >= 1; len--) {
            const name = segs.slice(i, i + len).join("-");
            const candidate = path.join(current, name);
            if (exists(candidate)) {
                current = candidate;
                i += len;
                matched = true;
                break;
            }
        }
        if (!matched) {
            // 実在しないセグメントはそのまま結合してフォールバック
            current = path.join(current, segs.slice(i).join("-"));
            break;
        }
    }
    return current;
}

// スキル利用統計（セッションのSkill呼び出し "skill":"名前" を集計）
function skillUsage() {
    const usage = {};
    const pdir = path.join(CLAUDE_DIR, "projects");
    if (!exists(pdir)) return usage;
    for (const key of fs.readdirSync(pdir)) {
        const dir = path.join(pdir, key);
        let files; try { files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")); } catch { continue; }
        for (const f of files) {
            const raw = readSafe(path.join(dir, f)); if (!raw || !raw.includes('"skill"')) continue;
            const cwdM = raw.match(/"cwd":\s*"([^"]+)"/);
            const proj = cwdM ? cwdM[1].split("/").filter(Boolean).pop() : key;
            for (const m of raw.matchAll(/"skill":\s*"([^"]+)"/g)) {
                const name = m[1];
                const u = usage[name] || (usage[name] = { count: 0, projects: {} });
                u.count++; u.projects[proj] = (u.projects[proj] || 0) + 1;
            }
        }
    }
    return usage;
}

/* ───────── API: スキル一覧 ───────── */
app.get("/api/skills", (req, res) => {
    const skills = [];
    const usage = skillUsage();
    const attachUsage = (s) => {
        const u = usage[s.name];
        s.usageCount = u ? u.count : 0;
        s.usageProjects = u ? Object.entries(u.projects).sort((x, y) => y[1] - x[1]).map(([name, count]) => ({ name, count })) : [];
        return s;
    };

    // ローカルスキル ~/.claude/skills/*/SKILL.md
    const skillsDir = path.join(CLAUDE_DIR, "skills");
    if (exists(skillsDir)) {
        for (const name of fs.readdirSync(skillsDir)) {
            const f = path.join(skillsDir, name, "SKILL.md");
            const raw = readSafe(f);
            if (raw) {
                const { data } = parseFrontmatter(raw);
                skills.push(attachUsage({ name: data.name || name, description: data.description || "", source: "local", path: f }));
            }
        }
    }

    // プラグインのスキル plugins/marketplaces/*/(plugins|external_plugins)/*/skills/*/SKILL.md
    const mkt = path.join(CLAUDE_DIR, "plugins", "marketplaces");
    if (exists(mkt)) {
        for (const market of fs.readdirSync(mkt)) {
            for (const group of ["plugins", "external_plugins"]) {
                const gdir = path.join(mkt, market, group);
                if (!exists(gdir)) continue;
                for (const plugin of fs.readdirSync(gdir)) {
                    const sdir = path.join(gdir, plugin, "skills");
                    if (!exists(sdir)) continue;
                    for (const s of fs.readdirSync(sdir)) {
                        const f = path.join(sdir, s, "SKILL.md");
                        const raw = readSafe(f);
                        if (raw) {
                            const { data } = parseFrontmatter(raw);
                            skills.push(attachUsage({ name: data.name || s, description: data.description || "", source: `plugin:${plugin}`, path: f }));
                        }
                    }
                }
            }
        }
    }
    skills.sort((a, b) => b.usageCount - a.usageCount);
    res.json(skills);
});

/* ───────── サブエージェント利用統計（セッションのTask呼び出しを集計） ───────── */
// 各 jsonl を軽量に正規表現走査して subagent_type の使用回数とプロジェクト別内訳を取る。
function agentUsage() {
    const usage = {};   // name -> { count, projects: {proj:count} }
    const pdir = path.join(CLAUDE_DIR, "projects");
    if (!exists(pdir)) return usage;
    for (const key of fs.readdirSync(pdir)) {
        const dir = path.join(pdir, key);
        let files; try { files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")); } catch { continue; }
        for (const f of files) {
            const raw = readSafe(path.join(dir, f)); if (!raw || !raw.includes("subagent_type")) continue;
            const cwdM = raw.match(/"cwd":\s*"([^"]+)"/);
            const proj = cwdM ? cwdM[1].split("/").filter(Boolean).pop() : key;
            for (const m of raw.matchAll(/"subagent_type":\s*"([^"]+)"/g)) {
                const name = m[1];
                const u = usage[name] || (usage[name] = { count: 0, projects: {} });
                u.count++; u.projects[proj] = (u.projects[proj] || 0) + 1;
            }
        }
    }
    return usage;
}

/* ───────── API: サブエージェント一覧 ───────── */
app.get("/api/agents", (req, res) => {
    const agents = [];
    const seen = new Set();
    const usage = agentUsage();
    const attachUsage = (a) => {
        const u = usage[a.name];
        a.usageCount = u ? u.count : 0;
        a.usageProjects = u ? Object.entries(u.projects).sort((x, y) => y[1] - x[1]).map(([name, count]) => ({ name, count })) : [];
        return a;
    };

    // ~/.claude/agents/*.md（ユーザー定義）
    const adir = path.join(CLAUDE_DIR, "agents");
    if (exists(adir)) {
        for (const f of fs.readdirSync(adir).filter(x => x.endsWith(".md"))) {
            const full = path.join(adir, f);
            const { data } = parseFrontmatter(readSafe(full) || "");
            const name = data.name || f.replace(/\.md$/, "");
            agents.push(attachUsage({ name, description: data.description || "", source: "user", path: full }));
            seen.add(name);
        }
    }

    // プラグインのエージェント */agents/*.md
    const mkt = path.join(CLAUDE_DIR, "plugins", "marketplaces");
    if (exists(mkt)) {
        for (const market of fs.readdirSync(mkt)) {
            for (const group of ["plugins", "external_plugins"]) {
                const gdir = path.join(mkt, market, group);
                if (!exists(gdir)) continue;
                for (const plugin of fs.readdirSync(gdir)) {
                    const agdir = path.join(gdir, plugin, "agents");
                    if (!exists(agdir)) continue;
                    for (const f of fs.readdirSync(agdir).filter(x => x.endsWith(".md"))) {
                        const full = path.join(agdir, f);
                        const { data } = parseFrontmatter(readSafe(full) || "");
                        const name = data.name || f.replace(/\.md$/, "");
                        if (seen.has(name)) continue;
                        agents.push(attachUsage({ name, description: data.description || "", source: `plugin:${plugin}`, path: full }));
                        seen.add(name);
                    }
                }
            }
        }
    }

    // 組み込みエージェント（ファイル定義は無いが常時利用可）— 実利用があるものも拾う
    const BUILTIN = ["general-purpose", "Explore", "Plan", "claude-code-guide", "statusline-setup", "claude"];
    for (const name of new Set([...BUILTIN, ...Object.keys(usage)])) {
        if (seen.has(name)) continue;
        agents.push(attachUsage({ name, description: "", source: "builtin", path: null }));
        seen.add(name);
    }

    // 利用回数が多い順
    agents.sort((a, b) => b.usageCount - a.usageCount);
    res.json(agents);
});

/* ───────── API: プロジェクト一覧 ───────── */
// markdownを平文化（スニペット用）
function stripMd(s) {
    return (s || "")
        .replace(/```[\s\S]*?```/g, "")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/[*_`>#-]/g, "")
        .replace(/\[\[([^\]]+)\]\]/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/\s+/g, " ")
        .trim();
}

// 概要：README.md → CLAUDE.md の最初の意味ある段落
function extractOverview(dir) {
    for (const fn of ["README.md", "CLAUDE.md"]) {
        const raw = readSafe(path.join(dir, fn));
        if (!raw) continue;
        const { body } = parseFrontmatter(raw);
        const blocks = body.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
        for (const b of blocks) {
            // 警告ブロック（[!CAUTION]等）や引用・バッジ行はスキップ
            if (/^>/.test(b) || /\[!/.test(b) || /^!\[/.test(b)) continue;
            const t = stripMd(b);
            if (t.length > 24) return { text: t.slice(0, 220), source: fn };
        }
    }
    return null;
}

// ロードマップ：ROADMAP.md 優先、無ければ各docのロードマップ節。チェックボックスを集計
function extractRoadmap(dir) {
    let raw = readSafe(path.join(dir, "ROADMAP.md"));
    let source = "ROADMAP.md";
    if (!raw) {
        const cm = readSafe(path.join(dir, "CLAUDE.md")) || "";
        const m = cm.match(/#+\s*(?:ロードマップ|roadmap|開発計画)[\s\S]*/i);
        if (m) { raw = m[0]; source = "CLAUDE.md"; }
    }
    if (!raw) return null;
    const checks = [...raw.matchAll(/^[\s>-]*\[([ xX])\]\s+(.*)$/gm)];
    const done = checks.filter(c => c[1].toLowerCase() === "x").length;
    const pending = checks.filter(c => c[1] === " ").map(c => stripMd(c[2])).filter(Boolean).slice(0, 4);
    const phases = [...raw.matchAll(/^#{2,3}\s+(.*(?:Phase|フェーズ|Stage|ステージ).*)$/gim)].map(m => stripMd(m[1])).slice(0, 4);
    if (!checks.length && !phases.length) return null;
    return { total: checks.length, done, pending, phases, source };
}

// 課題・問題：キーワードを含む行を抽出
function extractIssues(dir) {
    const out = [];
    const re = /(課題|問題点?|不具合|バグ|TODO|FIXME|未対応|要改善|ボトルネック|⚠)/i;
    for (const fn of ["ROADMAP.md", "CLAUDE.md", "README.md"]) {
        const raw = readSafe(path.join(dir, fn));
        if (!raw) continue;
        for (const line of raw.split("\n")) {
            const t = stripMd(line);
            if (t.length > 8 && t.length < 140 && re.test(t)) out.push(t);
            if (out.length >= 5) break;
        }
        if (out.length >= 5) break;
    }
    return out;
}

app.get("/api/projects", (req, res) => {
    const projects = [];
    const pdir = path.join(CLAUDE_DIR, "projects");
    if (exists(pdir)) {
        for (const key of fs.readdirSync(pdir)) {
            const memDir = path.join(pdir, key, "memory");
            const memFiles = exists(memDir)
                ? fs.readdirSync(memDir).filter(f => f.endsWith(".md") && f !== "MEMORY.md")
                : [];
            const memIndexPath = exists(path.join(memDir, "MEMORY.md")) ? path.join(memDir, "MEMORY.md") : null;
            const realPath = keyToPath(key);
            const hasDir = exists(realPath);
            const claudeMd = path.join(realPath, "CLAUDE.md");
            // 利用頻度＝そのプロジェクトのセッション記録(.jsonl)数
            let sessionCount = 0;
            try { sessionCount = fs.readdirSync(path.join(pdir, key)).filter(f => f.endsWith(".jsonl")).length; } catch {}

            // メモリの一行要約（frontmatter description）＝特徴情報のアイキャッチ
            const memories = memFiles.map(f => {
                const { data } = parseFrontmatter(readSafe(path.join(memDir, f)) || "");
                return { name: data.name || f.replace(/\.md$/, ""), description: data.description || "", path: path.join(memDir, f), type: (data.type || (data.metadata && data.metadata.type) || "") };
            });

            projects.push({
                key,
                path: realPath,
                name: path.basename(realPath) || key,
                hasProjectDir: hasDir,
                sessionCount,
                memoryCount: memFiles.length,
                memories,
                memoryIndexPath: memIndexPath,
                claudeMd: exists(claudeMd) ? claudeMd : null,
                overview: hasDir ? extractOverview(realPath) : null,
                roadmap: hasDir ? extractRoadmap(realPath) : null,
                issues: hasDir ? extractIssues(realPath) : [],
            });
        }
    }
    // よく使われている順（セッション数優先＋情報量）
    const score = p => p.sessionCount * 10 + (p.overview ? 3 : 0) + (p.roadmap ? 3 : 0) + (p.issues.length ? 2 : 0) + p.memoryCount;
    projects.sort((a, b) => score(b) - score(a));
    res.json(projects);
});

/* ───────── API: 稼働・統計 ───────── */
app.get("/api/stats", (req, res) => {
    const stats = jsonSafe(path.join(CLAUDE_DIR, "stats-cache.json")) || {};
    const settings = jsonSafe(path.join(CLAUDE_DIR, "settings.json")) || {};
    const mcpAuth = jsonSafe(path.join(CLAUDE_DIR, "mcp-needs-auth-cache.json")) || {};

    const daily = stats.dailyActivity || [];
    const recent = daily.slice(-30);
    const totals = daily.reduce((a, d) => ({
        messages: a.messages + (d.messageCount || 0),
        sessions: a.sessions + (d.sessionCount || 0),
        toolCalls: a.toolCalls + (d.toolCallCount || 0),
    }), { messages: 0, sessions: 0, toolCalls: 0 });

    let sessionFiles = 0;
    const sdir = path.join(CLAUDE_DIR, "sessions");
    if (exists(sdir)) { try { sessionFiles = fs.readdirSync(sdir).length; } catch {} }

    // レートリミット検出
    const rateLimitEvents = [];
    const pdir = path.join(CLAUDE_DIR, "projects");
    if (exists(pdir)) {
        try {
            const files = [];
            for (const key of fs.readdirSync(pdir)) {
                const dir = path.join(pdir, key);
                let subfiles = [];
                try {
                    subfiles = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl"));
                } catch { continue; }
                for (const f of subfiles) {
                    const full = path.join(dir, f);
                    try {
                        const st = fs.statSync(full);
                        files.push({ key, f, full, mtime: st.mtimeMs });
                    } catch {}
                }
            }
            
            const isRateLimitFile = (str) => {
                return /isApiErrorMessage|apiErrorStatus|rate_limit|session[- ]limit|hit your.*limit|resets\s+\d/i.test(str);
            };

            const isRateLimitObject = (o) => {
                if (!o) return false;
                if (o.isApiErrorMessage === true || o.apiErrorStatus === 429 || o.error === "rate_limit") {
                    return true;
                }
                if (o.error && /rate[-_ ]?limit|overloaded|exhausted|quota/i.test(String(o.error))) {
                    return true;
                }
                if (o.message && o.message.content && Array.isArray(o.message.content)) {
                    for (const item of o.message.content) {
                        if (item.type === "text" && /hit your.*limit|resets\s+\d+(:\d+)?\s*(am|pm)/i.test(item.text || "")) {
                            return true;
                        }
                    }
                }
                return false;
            };

            // mtime の降順（新しい順）にソートして最新の15個をスキャン
            files.sort((a, b) => b.mtime - a.mtime);
            const scanTarget = files.slice(0, 15);
            
            for (const target of scanTarget) {
                const content = readSafe(target.full);
                if (!content) continue;
                
                if (isRateLimitFile(content)) {
                    const lines = content.split("\n").filter(Boolean);
                    let detectedObj = null;
                    
                    for (let i = lines.length - 1; i >= 0; i--) {
                        try {
                            const o = JSON.parse(lines[i]);
                            if (isRateLimitObject(o)) {
                                detectedObj = o;
                                break;
                            }
                        } catch {}
                    }
                    
                    if (detectedObj) {
                        const cwd = target.key ? keyToPath(target.key) : null;
                        const projName = cwd ? String(cwd).split("/").filter(Boolean).pop() : target.key;
                        
                        let preview = "";
                        if (detectedObj.message && detectedObj.message.content && Array.isArray(detectedObj.message.content)) {
                            const textItem = detectedObj.message.content.find(x => x.type === "text");
                            if (textItem) preview = textItem.text || "";
                        }
                        if (!preview && detectedObj.error) {
                            preview = String(detectedObj.error);
                        }
                        if (!preview) {
                            preview = JSON.stringify(detectedObj).slice(0, 100);
                        }
                        preview = preview.slice(0, 100);
                        
                        rateLimitEvents.push({
                            sessionId: target.f.replace(/\.jsonl$/, ""),
                            project: projName,
                            projectKey: target.key,
                            timestamp: detectedObj.timestamp || new Date(target.mtime).toISOString(),
                            preview: preview
                        });
                    }
                }
            }
        } catch (e) {
            console.error("Error scanning rate limit events:", e);
        }
    }

    res.json({
        lastComputedDate: stats.lastComputedDate || null,
        totals,
        recent,
        sessionFiles,
        settings: {
            model: settings.model || "(未設定)",
            permissions: settings.permissions ? Object.keys(settings.permissions) : [],
            hooks: settings.hooks ? Object.keys(settings.hooks) : [],
            env: settings.env ? Object.keys(settings.env) : [],
        },
        mcpNeedsAuth: Object.keys(mcpAuth || {}),
        dailyModelTokens: stats.dailyModelTokens || [],
        modelUsage: stats.modelUsage || {},
        rateLimitEvents
    });
});

/* ───────── API: MCP 連携（接続状況・追加） ───────── */
app.get("/api/mcp", (req, res) => {
    const mcpAuth = jsonSafe(path.join(CLAUDE_DIR, "mcp-needs-auth-cache.json")) || {};
    const needsAuth = Object.keys(mcpAuth);
    _exec(`${shq(CLAUDE_BIN)} mcp list`, { timeout: 20000 }, (err, stdout) => {
        const connected = [];
        const clean = (stdout || "").replace(/\x1b\[[0-9;]*m/g, ""); // ANSI除去
        for (const line of clean.split("\n")) {
            if (/Checking|^\s*$/.test(line)) continue;
            const m = line.match(/^(.+?):\s*(\S+)\s*-\s*(.+)$/);
            if (m) connected.push({ name: m[1].trim(), url: m[2], ok: /Connected|✔|✓/.test(m[3]) });
        }
        res.json({ ok: true, connected, needsAuth });
    });
});

app.post("/api/mcp/add", (req, res) => {
    const { name, url, transport = "http" } = req.body;
    if (!name || !url) return res.status(400).json({ ok: false, error: "name と url が必要です" });
    const t = ["http", "sse"].includes(transport) ? transport : "http";
    const cmd = `${shq(CLAUDE_BIN)} mcp add --transport ${t} ${shq(name)} ${shq(url)}`;
    _exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
        if (err) return res.status(500).json({ ok: false, error: (stderr || err.message || "").slice(0, 400) });
        res.json({ ok: true, output: (stdout || "").trim() });
    });
});

/* ───────── API: プロジェクト削除（ゴミ箱へ退避） ───────── */
app.delete("/api/project", (req, res) => {
    const key = req.query.key;
    if (!key) return res.status(400).json({ ok: false, error: "key必須" });
    const dir = path.join(CLAUDE_DIR, "projects", key);
    const abs = path.resolve(dir);
    if (!abs.startsWith(path.join(CLAUDE_DIR, "projects") + path.sep)) return res.status(403).json({ ok: false, error: "不正なパス" });
    if (!exists(abs)) return res.status(404).json({ ok: false, error: "存在しません" });
    try {
        const trash = path.join(CLAUDE_DIR, ".cm-trash");
        fs.mkdirSync(trash, { recursive: true });
        fs.renameSync(abs, path.join(trash, `${key}.${Date.now()}`)); // 復元可能なよう退避
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

/* ───────── API: 翻訳（英→日・まとめて1回） ───────── */
const _transCache = {};
app.post("/api/translate", (req, res) => {
    const texts = Array.isArray(req.body.texts) ? req.body.texts.slice(0, 60) : [];
    if (!texts.length) return res.json({ ok: true, translations: [] });
    const todo = texts.filter(t => !(t in _transCache));
    if (!todo.length) return res.json({ ok: true, translations: texts.map(t => _transCache[t]) });
    const prompt = `次の英語テキストを、それぞれ自然で簡潔な日本語に翻訳してください。番号付きの行で、入力と同じ順・同じ件数で、JSON配列（文字列のみ）だけを出力してください。説明文は不要。\n\n${todo.map((t, i) => `${i + 1}. ${t}`).join("\n")}`;
    const cmd = `${shq(CLAUDE_BIN)} -p ${shq(prompt)} --model haiku --allowedTools Read`;
    _exec(cmd, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        let arr = [];
        const m = (stdout || "").match(/\[[\s\S]*\]/);
        if (m) { try { arr = JSON.parse(m[0]); } catch {} }
        todo.forEach((t, i) => { _transCache[t] = arr[i] || t; });
        res.json({ ok: true, translations: texts.map(t => _transCache[t] || t) });
    });
});

/* ───────── API: ルーチン／バックグラウンド・エージェント ───────── */
app.get("/api/routines", (req, res) => {
    // ローカルに残るルーチン最終実行時刻（クラウドのroutine一覧自体はローカルに無い）
    let lastFired = null;
    const cj = jsonSafe(path.join(HOME, ".claude.json"));
    if (cj && cj.routineFiredWatermark) lastFired = cj.routineFiredWatermark;

    _exec(`${shq(CLAUDE_BIN)} agents --json --all`, { timeout: 30000 }, (err, stdout) => {
        let agents = [];
        try { agents = JSON.parse(stdout || "[]"); } catch {}
        agents = (Array.isArray(agents) ? agents : []).map(a => ({
            sessionId: a.sessionId, cwd: a.cwd, kind: a.kind,
            status: a.status || "running",
            startedAt: a.startedAt ? new Date(a.startedAt).toISOString() : null,
        })).sort((x, y) => (y.startedAt || "").localeCompare(x.startedAt || ""));
        res.json({ ok: true, agents, lastFired });
    });
});

/* ───────── API: ファイル読み書き（編集） ───────── */
app.get("/api/file", (req, res) => {
    const p = req.query.path;
    if (!p) return res.status(400).json({ ok: false, error: "path必須" });
    // 読み取りも許可パスに限定（任意ファイル漏洩を防ぐ）
    if (!isWritable(p)) return res.status(403).json({ ok: false, error: "このパスは閲覧不可（~/.claude配下とCLAUDE.mdのみ）" });
    const content = readSafe(p);
    if (content == null) return res.status(404).json({ ok: false, error: "読めません" });
    res.json({ ok: true, content, writable: isWritable(p) });
});

app.put("/api/file", (req, res) => {
    const { path: p, content } = req.body;
    if (!p) return res.status(400).json({ ok: false, error: "path必須" });
    if (!isWritable(p)) return res.status(403).json({ ok: false, error: "このパスは編集不可（~/.claude配下とCLAUDE.mdのみ）" });
    try {
        // バックアップ
        if (exists(p)) fs.copyFileSync(p, p + ".bak");
        fs.writeFileSync(p, content, "utf8");
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

/* ───────── API: グローバル設定（全体CLAUDE.md / settings.json） ───────── */
app.get("/api/config", (req, res) => {
    const globalMd = path.join(CLAUDE_DIR, "CLAUDE.md");
    const settings = path.join(CLAUDE_DIR, "settings.json");
    res.json({
        items: [
            { name: "CLAUDE.md（全体指示）", path: globalMd, exists: exists(globalMd), kind: "md" },
            { name: "settings.json", path: settings, exists: exists(settings), kind: "json" },
        ],
    });
});

/* ───────── API: 新規作成（スキル / エージェント / メモリ） ───────── */
const TEMPLATES = {
    skill: (name) => `---
name: ${name}
description: （このスキルがいつ使われるべきかを一文で。具体的なトリガー語を含める）
---

# ${name}

（ここに手順・ノウハウ・ルールを書く）
`,
    agent: (name) => `---
name: ${name}
description: （このサブエージェントをいつ使うか。委譲の判断基準を書く）
---

あなたは ${name} です。

（システムプロンプト本文：役割・進め方・出力形式）
`,
    memory: (name) => `---
name: ${name}
description: （一行要約 — recall時の関連判定に使われる）
metadata:
  type: project
---

（ここに事実を書く。関連メモリは [[other-name]] でリンク）
`,
};

app.post("/api/create", (req, res) => {
    const { type, name, projectKey } = req.body;
    const slug = (name || "").trim().replace(/[^\w\-ぁ-んァ-ヶ一-龠]/g, "-").replace(/^-+|-+$/g, "");
    if (!slug) return res.status(400).json({ ok: false, error: "名前が必要です" });

    let target;
    try {
        if (type === "skill") {
            const dir = path.join(CLAUDE_DIR, "skills", slug);
            if (exists(dir)) return res.status(409).json({ ok: false, error: "同名のスキルが既に存在します" });
            fs.mkdirSync(dir, { recursive: true });
            target = path.join(dir, "SKILL.md");
        } else if (type === "agent") {
            const dir = path.join(CLAUDE_DIR, "agents");
            fs.mkdirSync(dir, { recursive: true });
            target = path.join(dir, `${slug}.md`);
            if (exists(target)) return res.status(409).json({ ok: false, error: "同名のエージェントが既に存在します" });
        } else if (type === "memory") {
            if (!projectKey) return res.status(400).json({ ok: false, error: "projectKeyが必要です" });
            const dir = path.join(CLAUDE_DIR, "projects", projectKey, "memory");
            fs.mkdirSync(dir, { recursive: true });
            target = path.join(dir, `${slug}.md`);
            if (exists(target)) return res.status(409).json({ ok: false, error: "同名のメモリが既に存在します" });
        } else {
            return res.status(400).json({ ok: false, error: "type不正" });
        }
        fs.writeFileSync(target, TEMPLATES[type](slug), "utf8");
        res.json({ ok: true, path: target });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

/* ───────── API: 削除（.bakを残す） ───────── */
app.delete("/api/file", (req, res) => {
    const p = req.query.path;
    if (!p) return res.status(400).json({ ok: false, error: "path必須" });
    if (!isWritable(p)) return res.status(403).json({ ok: false, error: "削除不可パス" });
    try {
        if (!exists(p)) return res.status(404).json({ ok: false, error: "存在しません" });
        fs.copyFileSync(p, p + ".bak"); // 復元用に退避
        fs.unlinkSync(p);
        // スキルは親フォルダ（SKILL.mdのみ）も掃除
        const parent = path.dirname(p);
        if (parent.includes(path.join("skills", "")) && path.basename(p) === "SKILL.md") {
            try { if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent); } catch {}
        }
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

/* ───────── 組み込みアシスタント（Claude Code headless / Grok / AGY） ───────── */
const CLAUDE_BIN = fs.existsSync(`${HOME}/.local/bin/claude`) ? `${HOME}/.local/bin/claude` : "claude";
const GROK_BIN = fs.existsSync(`${HOME}/.grok/bin/grok`) ? `${HOME}/.grok/bin/grok` : "grok";
const AGY_BIN = fs.existsSync(`${HOME}/.local/bin/agy`) ? `${HOME}/.local/bin/agy` : "agy";

const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const pickModel = (m, engine) => {
    if (engine === "grok") return m || "grok-2-latest";
    if (engine === "agy") return m || "gemini-1.5-pro";
    return m === "opus" ? "opus" : m === "sonnet" ? "sonnet" : "haiku";
};

// 対象パスからドメインを推定して文脈を作る
function domainContext(p) {
    if (!p) return "";
    if (p.includes("/skills/")) return `\n対象は「スキル定義(SKILL.md)」です: ${p}\nname/description（トリガー）と本文の手順の質に注目してください。`;
    if (p.includes("/agents/")) return `\n対象は「サブエージェント定義」です: ${p}\n役割・委譲基準(description)・システムプロンプトの明確さに注目してください。`;
    if (p.endsWith("CLAUDE.md")) return `\n対象は「プロジェクト/全体の指示書(CLAUDE.md)」です: ${p}\n運用ルール・手順の整合性に注目してください。`;
    if (p.includes("/memory/")) return `\n対象は「プロジェクトのメモリ」です: ${p}`;
    if (p.endsWith("settings.json")) return `\n対象は「settings.json」です: ${p}\nJSONとして妥当な形を保ってください。`;
    return `\n対象ファイル: ${p}`;
}

function buildSystem(mode, contextPath) {
    const base = `あなたは ClaudeManager に組み込まれた、設定（スキル・サブエージェント・プロジェクト指示・メモリ）の調整を支援するアシスタントです。`;
    const ctx = domainContext(contextPath);
    if (mode === "apply") {
        return `${base}${ctx}
【実行モード】指示を即座に実行してファイルを編集し、何をどう変えたか日本語で簡潔に報告すること。確認や許可は求めない。変更は最小限・的確に、既存の文体と構造を尊重する。`;
    }
    return `${base}${ctx}
【相談モード】ファイルは編集しないこと。指示に対して、変更案・追記する文面・修正の要点を具体的に（必要なら差分の形で）日本語で提示する。読み取りのみ行い、ユーザーが承認したら別途実行される。`;
}

// mode: "propose"(編集しない) / "apply"(編集する)
app.post("/api/assistant", (req, res) => {
    const { prompt, model, mode = "propose", target = "config", cwd, contextPath, sessionId, isNew, engine = "claude" } = req.body;
    if (!prompt || !prompt.trim()) return res.status(400).json({ ok: false, error: "指示が必要です" });

    let workdir = CLAUDE_DIR;
    if (target === "project" && cwd && fs.existsSync(cwd)) workdir = cwd;

    const mdl = pickModel(model, engine);
    const systemPrompt = buildSystem(mode, contextPath);
    let cmd = "";

    if (engine === "grok") {
        const fullPrompt = `${systemPrompt}\n\n[USER INSTRUCTION]\n${prompt}\n\n対象ディレクトリ(CWD): ${workdir}`;
        cmd = `${shq(GROK_BIN)} --always-approve -p ${shq(fullPrompt)} -m ${shq(mdl)}`;
    } else if (engine === "agy") {
        const fullPrompt = `${systemPrompt}\n\n[USER INSTRUCTION]\n${prompt}\n\n対象ディレクトリ(CWD): ${workdir}`;
        const toolFlag = mode === "apply" ? "--dangerously-skip-permissions" : "";
        cmd = `${shq(AGY_BIN)} -p ${shq(fullPrompt)} --model ${shq(mdl)} ${toolFlag}`;
    } else {
        const sessFlag = sessionId ? (isNew ? `--session-id ${sessionId}` : `--resume ${shq(sessionId)}`) : "";
        const toolFlag = mode === "apply" ? "--dangerously-skip-permissions" : "--allowedTools Read Glob Grep";
        cmd = `${shq(CLAUDE_BIN)} -p ${shq(prompt)} --model ${shq(mdl)} ${sessFlag} ${toolFlag} ` +
            `--append-system-prompt ${shq(systemPrompt)} --add-dir ${shq(CLAUDE_DIR)}`;
    }

    _exec(cmd, { cwd: workdir, maxBuffer: 10 * 1024 * 1024, timeout: 300000 }, (err, stdout, stderr) => {
        if (err && !stdout) return res.status(500).json({ ok: false, error: (stderr || err.message || "").slice(0, 600) });
        res.json({ ok: true, output: (stdout || stderr || "").trim(), model: mdl, mode, engine });
    });
});

/* ───────── セッション可視化（transcript解析） ───────── */
function tailLines(file, n) {
    try {
        const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
        return { lines, total: lines.length };
    } catch { return { lines: [], total: 0 }; }
}
function summarizeEvent(o) {
    if (!o) return null;
    const ts = o.timestamp || null;
    if (o.type === "user") {
        const c = o.message?.content;
        const txt = typeof c === "string" ? c : Array.isArray(c) ? c.map(x => x.text || (x.type === "tool_result" ? "[tool結果]" : "")).join(" ") : "";
        return { role: "user", text: (txt || "").slice(0, 400), ts };
    }
    if (o.type === "assistant") {
        const c = o.message?.content || [];
        const txt = Array.isArray(c) ? c.filter(x => x.type === "text").map(x => x.text).join(" ") : "";
        const tools = Array.isArray(c) ? c.filter(x => x.type === "tool_use").map(x => x.name) : [];
        return { role: "assistant", text: (txt || "").slice(0, 400), tools, ts };
    }
    return null;
}

app.get("/api/sessions", (req, res) => {
    const out = [];
    const pdir = path.join(CLAUDE_DIR, "projects");
    if (exists(pdir)) {
        for (const key of fs.readdirSync(pdir)) {
            const dir = path.join(pdir, key);
            let files;
            try { files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")); } catch { continue; }
            for (const f of files) {
                const full = path.join(dir, f);
                let st; try { st = fs.statSync(full); } catch { continue; }
                const { lines, total } = tailLines(full);
                if (!total) continue;
                let first = {}, last = {};
                try { first = JSON.parse(lines[0]); } catch {}
                let lastSummary = null, cwd = first.cwd || null, entry = first.entrypoint || null;
                for (let i = lines.length - 1; i >= 0 && i > lines.length - 60; i--) {
                    try { const o = JSON.parse(lines[i]); last = o.timestamp ? o : last; cwd = cwd || o.cwd; entry = entry || o.entrypoint;
                        const s = summarizeEvent(o); if (!lastSummary && s && (s.text || (s.tools && s.tools.length))) lastSummary = s;
                    } catch {}
                }
                const mtime = st.mtimeMs;
                const projName = cwd ? String(cwd).split("/").filter(Boolean).pop() : null;
                out.push({
                    id: f.replace(/\.jsonl$/, ""), key, cwd, entrypoint: entry,
                    project: projName,
                    title: deriveTitle(lines),
                    events: total, startedAt: first.timestamp || null, lastAt: last.timestamp || new Date(mtime).toISOString(),
                    mtime, active: (Date.now() - mtime) < 180000,
                    last: lastSummary,
                });
            }
        }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    res.json(out);
});

app.get("/api/session", (req, res) => {
    const { key, id } = req.query;
    if (!key || !id) return res.status(400).json({ ok: false, error: "key,id必須" });
    const full = path.join(CLAUDE_DIR, "projects", key, `${id}.jsonl`);
    if (!exists(full)) return res.status(404).json({ ok: false, error: "見つかりません" });
    const { lines, total } = tailLines(full);
    const events = [];
    for (let i = Math.max(0, lines.length - 50); i < lines.length; i++) {
        try { const s = summarizeEvent(JSON.parse(lines[i])); if (s && (s.text || (s.tools && s.tools.length))) events.push(s); } catch {}
    }
    const digest = sessionDigest(full);
    res.json({ ok: true, id, key, total, events, digest });
});

// アシスタントの宣言文から「決定・実施したこと」だけを抜き出す。
// 相談・前置き・質問は捨て、完了形/操作動詞を含む短い断定文のみ採用。
// 具体的な操作動詞（「何をどうした」）。把握/確認/サマリー等の説明文は拾わない。
const DECISION_RE = /(追加し|削除し|修正し|変更し|統一し|作成し|新設し|置き換え|差し替え|移動し|リネーム|改名し|無効化|有効化|導入し|除去し|実装し|分離し|集約し|復元し|廃止し|カード化|グループ化|フルスクリーン化|を追加|を削除|を修正|を変更|を作成|を統一|を新設|を分離|を集約|を廃止|に変更|に統一|に分離|に置き換|へ移動|にリネーム|を再起動|を折りたた)/;
// narration / 状況説明 / 問いかけ は除外
const DECISION_SKIP = /(でしょうか|ますか|ください|でしょう|かもしれ|と思います|提案|どうし|いかが|してOK|良ければ|確認しま|見てみ|調べ|把握しま|なっています|なっている|になります|できます|できる|分かりました|わかりました|了解|サマリー|要点|ポイント|注意|原因|問題が|について|とは|ご確認|報告|まとめると)/;
function extractDecisions(text) {
    if (!text) return [];
    const out = [];
    const parts = String(text).split(/\n+|。/).map(s => s
        .replace(/^[\s>*•・\-–—✓]+/, "")
        .replace(/^\d+[.)]\s*/, "")
        .replace(/^\*\*(.+?)\*\*[:：]?\s*/, "$1: ")
        .replace(/[`*_#]/g, "")
        .trim());
    for (let p of parts) {
        if (p.length < 6 || p.length > 80) continue;
        if (/[：:]$/.test(p)) continue;              // 見出し行
        if (/^[「『]/.test(p)) continue;             // 引用
        if (DECISION_SKIP.test(p)) continue;
        if (!DECISION_RE.test(p)) continue;
        if (/(します|します。?)$/.test(p) && p.length < 18) continue;   // 「実装します」等の宣言は除外
        if (/^(まず|次に|では|これで|最後に|それでは)/.test(p)) p = p.replace(/^(まず|次に|では|これで|最後に|それでは)[、,]?\s*/, "");
        out.push(p.slice(0, 76));
    }
    return out;
}

// 機能エリアの分類（決定文・ファイル名から「どの機能か」を推定＝主語）
function areaOf(text) {
    const t = String(text || "");
    if (/モバイル|スマホ|カード|画面|表示|レイアウト|オペレーター|マネージャー|UI|デザイン|フルスクリーン|余бел* |余白|ボタン|見出し|ヘッダ|サイドバー|\.html|\.css|\.tsx|\.jsx/i.test(t)) return "UI・画面";
    if (/API|サーバー|server|エンドポイント|digest|抽出|解析|統計|集計|レート|枠|セッション解析|\.ts\b|\.js\b|\.py\b/i.test(t)) return "サーバー・API";
    if (/CLAUDE\.md|README|ドキュメント|ロードマップ|整理|指示書|仕様/i.test(t)) return "ドキュメント";
    if (/設定|package|config|\.json|\.ya?ml|権限|フック|env|トークン|認証/i.test(t)) return "設定・基盤";
    return "その他";
}

// セッションの短い見出しを生成（例:「UI・画面の課題対応」）。最後の発言ではなく作業内容から導く。
function deriveTitle(lines) {
    let firstAsk = null; const files = new Set(); const creates = new Set();
    for (const ln of lines) {
        let o; try { o = JSON.parse(ln); } catch { continue; }
        if (o.type === "user" && !firstAsk) {
            const c = o.message?.content;
            const txt = typeof c === "string" ? c : Array.isArray(c) ? c.filter(x => x.type === "text" || typeof x === "string").map(x => x.text || x).join(" ") : "";
            const t = (txt || "").trim().replace(/\s+/g, " ");
            if (t && t.length > 3 && !t.startsWith("<") && !t.startsWith("[tool")) firstAsk = t;
        }
        if (o.type === "assistant") {
            const c = o.message?.content || [];
            if (Array.isArray(c)) c.forEach(x => {
                if (x.type === "tool_use" && /^(Edit|Write|NotebookEdit)$/.test(x.name || "") && x.input?.file_path) {
                    const f = String(x.input.file_path).split("/").pop();
                    files.add(f); if (x.name === "Write") creates.add(f);
                }
            });
        }
    }
    const area = files.size ? areaOf([...files].join(" ")) : (firstAsk ? areaOf(firstAsk) : "");
    const issueLike = /課題|不具合|バグ|崩れ|直|おかしい|エラー|はみ出|見えない|潰れ|ダサ/.test(firstAsk || "");
    let type;
    if (creates.size && files.size <= creates.size + 1) type = "新規構築";
    else if (creates.size) type = "機能追加";
    else if (issueLike) type = "課題対応";
    else if (files.size) type = "調整・改善";
    else type = "相談・調査";
    if (area && area !== "その他") return `${area}の${type}`;
    if (firstAsk) return firstAsk.replace(/[。、].*$/, "").slice(0, 22);
    return "作業セッション";
}

// プロジェクトの活動記録（記憶補助）：各セッションを「いつ・何を・どう変えたか」に復元。
// 細かなBash/Read等のノイズは集計せず、プロジェクトへの変更（編集/作成）とスキル/サブエージェント利用に絞る。
function sessionDigest(full) {
    const { lines } = tailLines(full);
    if (!lines.length) return null;
    let firstAsk = null, start = null, end = null, asstCount = 0, lastText = null;
    const edits = new Map();        // file -> 回数（変更）
    const creates = new Set();      // Write で新規作成
    const skills = new Map();       // skill名 -> 回数
    const agents = new Map();       // subagent_type -> 回数
    const userAsks = [];            // ユーザーの主要な指示（目的の特定用）
    const decisions = [];           // 決定・実施したこと（アシスタント宣言文）
    const seenDec = new Set();
    let bashText = "";              // Bashコマンド集積（スキル化提案の判定用）
    for (const ln of lines) {
        let o; try { o = JSON.parse(ln); } catch { continue; }
        if (o.timestamp) { if (!start) start = o.timestamp; end = o.timestamp; }
        if (o.type === "user") {
            const c = o.message?.content;
            const txt = typeof c === "string" ? c
                : Array.isArray(c) ? c.filter(x => x.type === "text" || typeof x === "string").map(x => x.text || x).join(" ") : "";
            const t = (txt || "").trim().replace(/\s+/g, " ");
            if (t && t.length > 3 && !t.startsWith("<") && !t.startsWith("[tool")) {
                if (!firstAsk) firstAsk = t.slice(0, 180);
                if (userAsks.length < 8) userAsks.push(t.slice(0, 160));
            }
        }
        if (o.type === "assistant") {
            asstCount++;
            const c = o.message?.content || [];
            if (Array.isArray(c)) {
                const blocks = c.filter(x => x.type === "text").map(x => x.text);
                const tx = blocks.join(" ").trim();
                if (tx) lastText = tx.replace(/\s+/g, " ").slice(0, 600);
                // この発言から決定事項を抽出
                for (const b of blocks) for (const dec of extractDecisions(b)) {
                    const k = dec.replace(/\s/g, "");
                    if (seenDec.has(k)) continue; seenDec.add(k);
                    if (decisions.length < 40) decisions.push(dec);
                }
                c.forEach(x => {
                    if (x.type !== "tool_use") return;
                    const nm = x.name || "", inp = x.input || {};
                    if (nm === "Bash" && inp.command) bashText += " " + String(inp.command);
                    if (/^(Edit|Write|NotebookEdit)$/.test(nm) && inp.file_path) {
                        const f = String(inp.file_path).split("/").pop();
                        edits.set(f, (edits.get(f) || 0) + 1);
                        if (nm === "Write") creates.add(f);
                    } else if (nm === "Skill" && inp.skill) {
                        skills.set(inp.skill, (skills.get(inp.skill) || 0) + 1);
                    } else if (nm === "Task" && inp.subagent_type) {
                        agents.set(inp.subagent_type, (agents.get(inp.subagent_type) || 0) + 1);
                    }
                });
            }
        }
    }
    const mapArr = m => [...m.entries()].map(([name, count]) => ({ name, count }));
    // 決定事項を機能エリアでグルーピング（主語＝どの機能か）
    const groupsMap = {};
    for (const dec of decisions) { const a = areaOf(dec); (groupsMap[a] = groupsMap[a] || []).push(dec); }
    const decisionGroups = Object.entries(groupsMap)
        .sort((x, y) => y[1].length - x[1].length)
        .map(([area, items]) => ({ area, items }));
    // スキル化提案：デプロイ等の繰り返し手順が含まれるかを判定
    const allText = (decisions.join(" ") + " " + bashText).toLowerCase();
    let suggest = null;
    if (/deploy|デプロイ|release|本番|publish|リリース/.test(allText) || /deploy\.cjs|deploy-dev/.test(bashText)) {
        suggest = { kind: "deploy", text: "このセッションにはデプロイ／リリース手順が含まれています。毎回同じ流れなら、スキル化すると次回から一発で呼べます。" };
    } else if (/build|ビルド|migrate|マイグレ|backup|バックアップ|seed/.test(allText)) {
        suggest = { kind: "ops", text: "繰り返し実行しそうな運用手順（ビルド／移行など）が含まれています。スキル化しておくと安全・確実に再実行できます。" };
    } else if (decisions.length >= 8 || mapArr(edits).some(e => e.count >= 4)) {
        suggest = { kind: "repeat", text: "手順が多めのセッションです。定例化しそうなら、一連の流れをスキルにまとめておくと便利です。" };
    }
    return {
        title: deriveTitle(lines),
        start, end, turns: asstCount,
        firstAsk, lastText, userAsks, decisions, decisionGroups,
        edits: [...edits.keys()].slice(0, 12),          // 後方互換（ファイル名のみ）
        changes: mapArr(edits).slice(0, 20),            // {file,count}
        creates: [...creates].slice(0, 12),
        skills: mapArr(skills),
        agents: mapArr(agents),
        suggest,
    };
}
// 後方互換エイリアス
const sessionActivity = sessionDigest;

app.get("/api/project-activity", (req, res) => {
    const key = req.query.key;
    if (!key) return res.status(400).json({ ok: false, error: "key必須" });
    const dir = path.join(CLAUDE_DIR, "projects", key);
    if (!exists(dir)) return res.json({ ok: true, sessions: [] });
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")); } catch {}
    const sessions = files.map(f => {
        const a = sessionActivity(path.join(dir, f));
        return a ? { id: f.replace(/\.jsonl$/, ""), ...a } : null;
    }).filter(Boolean).sort((x, y) => (y.start || "").localeCompare(x.start || ""));
    res.json({ ok: true, sessions });
});

// 既存セッションに参加（履歴を引き継いでメッセージ投入）
app.post("/api/session/resume", (req, res) => {
    const { id, cwd, prompt, model = "haiku", apply = false, engine = "claude" } = req.body;
    if (!id || !prompt) return res.status(400).json({ ok: false, error: "id,prompt必須" });
    const workdir = (cwd && fs.existsSync(cwd)) ? cwd : CLAUDE_DIR;
    const toolFlag = apply ? "--dangerously-skip-permissions" : "--allowedTools Read Glob Grep";
    const mdl = pickModel(model, engine);

    let cmd = "";
    if (engine === "grok" || engine === "agy") {
        // Grok/AGY にはセッション再開機能がないため、直近のセッション要約をコンテキストに含める
        let sessionContext = "";
        // セッションのjsonlから直近の会話を抽出してコンテキスト化
        const pdir = path.join(CLAUDE_DIR, "projects");
        if (exists(pdir)) {
            for (const key of fs.readdirSync(pdir)) {
                const jsonlPath = path.join(pdir, key, `${id}.jsonl`);
                if (exists(jsonlPath)) {
                    const digest = sessionDigest(jsonlPath);
                    if (digest) {
                        const parts = [];
                        if (digest.firstAsk) parts.push(`最初の依頼: ${digest.firstAsk}`);
                        if (digest.decisions.length) parts.push(`実施済み事項:\n${digest.decisions.map(d => `- ${d}`).join("\n")}`);
                        if (digest.edits.length) parts.push(`編集済みファイル: ${digest.edits.join(", ")}`);
                        if (digest.lastText) parts.push(`直近のアシスタント発言: ${digest.lastText.slice(0, 300)}`);
                        sessionContext = `\n\n=== 前回セッションのコンテキスト ===\n${parts.join("\n\n")}`;
                    }
                    break;
                }
            }
        }
        const fullPrompt = `${prompt}${sessionContext}\n\n作業ディレクトリ: ${workdir}`;
        if (engine === "grok") {
            cmd = `${shq(GROK_BIN)} --always-approve -p ${shq(fullPrompt)} -m ${shq(mdl)}`;
        } else {
            const agyFlag = apply ? "--dangerously-skip-permissions" : "";
            cmd = `${shq(AGY_BIN)} -p ${shq(fullPrompt)} --model ${shq(mdl)} ${agyFlag}`;
        }
    } else {
        cmd = `${shq(CLAUDE_BIN)} -p ${shq(prompt)} --model ${shq(mdl)} --resume ${shq(id)} ${toolFlag}`;
    }

    _exec(cmd, { cwd: workdir, maxBuffer: 10 * 1024 * 1024, timeout: 300000 }, (err, stdout, stderr) => {
        if (err && !stdout) return res.status(500).json({ ok: false, error: (stderr || err.message || "").slice(0, 600) });
        res.json({ ok: true, output: (stdout || stderr || "").trim(), engine });
    });
});

/* ───────── 依頼ボード（マネージャーの受信箱・永続） ───────── */
// 各プロジェクトからの課題対応依頼を貯め、優先度をつけて捌くためのキュー。
const REQ_DIR = path.join(CLAUDE_DIR, "cc-manager");
const REQ_FILE = path.join(REQ_DIR, "requests.json");
function readReqs() { return jsonSafe(REQ_FILE) || []; }
function writeReqs(arr) {
    try { fs.mkdirSync(REQ_DIR, { recursive: true }); } catch {}
    if (exists(REQ_FILE)) { try { fs.copyFileSync(REQ_FILE, REQ_FILE + ".bak"); } catch {} }
    fs.writeFileSync(REQ_FILE, JSON.stringify(arr, null, 2));
}
// 自動優先度（マネージャー判定）：内容のキーワードから 高/中/低 を推定
function autoPriority(text) {
    const t = String(text || "");
    if (/不具合|バグ|崩れ|見えない|動かない|エラー|落ちる|本番|壊れ|セキュリティ|潰れ|はみ出|重大|至急|今すぐ/.test(t)) return "高";
    if (/いつか|あとで|余裕|細かい|nice|改善案|将来|検討|できれば/.test(t)) return "低";
    return "中";
}
const PRIO_RANK = { "高": 0, "中": 1, "低": 2 };

app.get("/api/requests", (req, res) => {
    const arr = readReqs().sort((a, b) =>
        (a.status === "done" ? 1 : 0) - (b.status === "done" ? 1 : 0) ||
        (PRIO_RANK[a.priority] ?? 1) - (PRIO_RANK[b.priority] ?? 1) ||
        (b.createdAt || "").localeCompare(a.createdAt || ""));
    res.json({ ok: true, requests: arr });
});
app.post("/api/requests", (req, res) => {
    const { project, projectKey, title, detail } = req.body || {};
    if (!title) return res.status(400).json({ ok: false, error: "title必須" });
    const arr = readReqs();
    const item = {
        id: crypto.randomBytes(6).toString("hex"),
        project: project || "（不明）", projectKey: projectKey || "",
        title: String(title).slice(0, 200), detail: String(detail || "").slice(0, 1000),
        priority: req.body.priority || autoPriority(title + " " + (detail || "")),
        autoPriority: !req.body.priority,
        status: "open", createdAt: new Date().toISOString(),
    };
    arr.push(item); writeReqs(arr);
    res.json({ ok: true, request: item });
});
app.patch("/api/requests", (req, res) => {
    const { id } = req.body || {};
    const arr = readReqs(); const it = arr.find(x => x.id === id);
    if (!it) return res.status(404).json({ ok: false, error: "見つかりません" });
    for (const k of ["priority", "status", "title", "detail"]) if (k in req.body) it[k] = req.body[k];
    if ("priority" in req.body) it.autoPriority = false;
    writeReqs(arr); res.json({ ok: true, request: it });
});
app.delete("/api/requests", (req, res) => {
    const id = req.query.id;
    const arr = readReqs().filter(x => x.id !== id);
    writeReqs(arr); res.json({ ok: true });
});

app.listen(PORT, HOST, () => {
    const tq = TOKEN ? `?token=${TOKEN}` : "";
    console.log(`\n  ClaudeManager`);
    console.log(`  ─────────────────────────────────────────────`);
    console.log(`  読込元: ${CLAUDE_DIR}`);
    console.log(`  bind:   ${HOST}:${PORT}`);
    if (!isRemoteExposed) {
        console.log(`\n  ローカル: http://localhost:${PORT}`);
        console.log(`\n  ※ 既定では localhost のみ。LAN/Tailscaleで開くには:`);
        console.log(`     npx claude-manager --host :: --open`);
    } else {
        console.log(`  認証:   トークン必須（リモートアクセス）`);
        console.log(`\n  ローカル:        http://localhost:${PORT}${tq}`);
        console.log(`  LAN/Tailscale:   http://<このマシンのIP>:${PORT}${tq}`);
        console.log(`     例 IPv6: http://[fd7a:....]:${PORT}${tq}  ← 角括弧[]必須`);
        console.log(`\n  ⚠ 上のトークン付きURLを共有してください（トークン無しでは拒否されます）`);
    }
    console.log("");
    if (OPEN) {
        const url = `http://localhost:${PORT}${tq}`;
        const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        _exec(`${cmd} "${url}"`);
    }
});
