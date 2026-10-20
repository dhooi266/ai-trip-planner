/* AI Trip Planner server (Railway). No dependencies: plain Node 20+.
   - Accounts: register with an invite code, log in with email + password (scrypt). Signed session cookie.
   - Each account's app data (trips, ticks, bookings, expenses) is synced to DATA_DIR/state/<uid>.json, so the
     same trips appear on every device. The page is served with the account's data inlined (window.__TP).
   - AI relay: /api/openai and /api/eleven add the server's keys (admin page or env), so keys never reach browsers.
     Only the app's own request types are relayed for normal users, with daily limits per user.
   - Admin page /admin: users, usage, disable / reset password / delete, invite code, limits, API keys.
   Data lives in DATA_DIR (Railway volume at /data). */
const http = require("http"), fs = require("fs"), fsp = fs.promises, path = require("path"), crypto = require("crypto");
const ROOT = __dirname, PORT = process.env.PORT || 3031;
const DATA = process.env.DATA_DIR || path.join(ROOT, ".data");
const COOKIE = "tp_s", MAX_AGE = 180 * 86400, STATE_CAP = 30 * 1024 * 1024;
const MODELS = ["gpt-5.4-mini", "gpt-5.4"];
const DEF_LIMITS = {trips:+process.env.LIMIT_TRIPS || 5, redos:+process.env.LIMIT_REDOS || 20, scans:+process.env.LIMIT_SCANS || 30, voice:+process.env.LIMIT_VOICE || 300};

/* ---------- tiny JSON store: atomic writes, one queue per file ---------- */
fs.mkdirSync(path.join(DATA, "state"), {recursive:true});
const queues = {};
function writeJSON(file, obj){
  const f = path.join(DATA, file), run = async () => { const tmp = f + "." + process.pid + ".tmp"; await fsp.writeFile(tmp, JSON.stringify(obj)); await fsp.rename(tmp, f); };
  return (queues[f] = (queues[f] || Promise.resolve()).then(run, run));
}
function readJSON(file, def){ try { return JSON.parse(fs.readFileSync(path.join(DATA, file), "utf8")); } catch(e) { return def; } }
const SECRET = (() => { let s = readJSON("secret.json", null); if (!s) { s = {k:crypto.randomBytes(32).toString("hex")}; fs.writeFileSync(path.join(DATA, "secret.json"), JSON.stringify(s)); } return s.k; })();
let USERS = readJSON("users.json", {users:[]}).users;
let SETTINGS = Object.assign({invite:process.env.INVITE_CODE || "", limits:DEF_LIMITS, openai:"", eleven:""}, readJSON("settings.json", {}));
SETTINGS.limits = Object.assign({}, DEF_LIMITS, SETTINGS.limits);
let USAGE = readJSON("usage.json", {day:"", users:{}});
const saveUsers = () => writeJSON("users.json", {users:USERS});
const saveSettings = () => writeJSON("settings.json", SETTINGS);
const OPENAI = () => SETTINGS.openai || process.env.OPENAI_API_KEY || "";
const ELEVEN = () => SETTINGS.eleven || process.env.ELEVENLABS_API_KEY || "";

/* ---------- passwords, sessions ---------- */
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString("hex");
const checkPw = (u, pw) => { const h = Buffer.from(hashPw(pw, u.salt), "hex"), k = Buffer.from(u.hash, "hex"); return h.length === k.length && crypto.timingSafeEqual(h, k); };
const sign = s => crypto.createHmac("sha256", SECRET).update(s).digest("base64url");
/* the token carries the password hash's tail, so a password reset logs that user out everywhere */
const tokenFor = u => { const p = u.id + "." + (Date.now() + MAX_AGE*1000) + "." + u.hash.slice(-8); return p + "." + sign(p); };
const cookies = req => Object.fromEntries((req.headers.cookie || "").split(/;\s*/).filter(Boolean).map(c => { const i = c.indexOf("="); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
function userOf(req){
  const t = cookies(req)[COOKIE] || "", parts = t.split("."); if (parts.length !== 4) return null;
  const [id, exp, tail, sig] = parts, p = id + "." + exp + "." + tail, good = sign(p);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good)) || +exp < Date.now()) return null;
  const u = USERS.find(x => x.id === id); return u && !u.disabled && u.hash.slice(-8) === tail ? u : null;
}
const setCookie = (res, v, age) => res.setHeader("Set-Cookie", `${COOKIE}=${v}; Max-Age=${age}; Path=/; HttpOnly; Secure; SameSite=Lax`);
const newPassword = () => crypto.randomBytes(9).toString("base64url").replace(/[-_]/g, "x").slice(0, 10);
function makeUser(email, name, pw, admin){
  const salt = crypto.randomBytes(16).toString("hex");
  const u = {id:"u" + crypto.randomBytes(6).toString("hex"), email, name, salt, hash:hashPw(pw, salt), admin:!!admin, created:new Date().toISOString(), lastLogin:null, disabled:false, total:{trips:0, redos:0, scans:0, voice:0}};
  USERS.push(u); saveUsers(); return u;
}
/* the first admin comes from ADMIN_EMAIL + ADMIN_PASSWORD (only used when that account doesn't exist yet) */
if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD && !USERS.some(u => u.email === process.env.ADMIN_EMAIL.toLowerCase()))
  makeUser(process.env.ADMIN_EMAIL.toLowerCase(), process.env.ADMIN_NAME || "Admin", process.env.ADMIN_PASSWORD, true);

/* ---------- daily usage (Malaysia time) ---------- */
const today = () => new Date(Date.now() + 8*3600e3).toISOString().slice(0, 10);
function use(u){ if (USAGE.day !== today()) USAGE = {day:today(), users:{}}; return USAGE.users[u.id] = USAGE.users[u.id] || {trips:0, redos:0, days:0, extras:0, scans:0, voice:0}; }
let usageTimer = null; const saveUsage = () => { clearTimeout(usageTimer); usageTimer = setTimeout(() => writeJSON("usage.json", USAGE), 2000); };
const LIMIT_MSG = {trips:"今天新行程的次数已用完 · Daily limit for new trips reached", redos:"今天重做的次数已用完 · Daily limit for day redos reached",
  scans:"今天识别预订／收据的次数已用完 · Daily limit for reading bookings and receipts reached", voice:"今天语音翻译的次数已用完 · Daily limit for voice translation reached"};

/* ---------- helpers ---------- */
const TYPES = {".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".css":"text/css", ".json":"application/json",
  ".webmanifest":"application/manifest+json", ".png":"image/png", ".jpg":"image/jpeg", ".webp":"image/webp", ".svg":"image/svg+xml", ".ico":"image/x-icon"};
const OPEN = p => p === "/manifest.webmanifest" || p === "/sw.js" || p.startsWith("/img/");
const json = (res, code, obj) => { res.writeHead(code, {"Content-Type":"application/json", "Cache-Control":"no-store"}); res.end(JSON.stringify(obj)); };
const fail = (res, code, msg) => json(res, code, {error:{message:msg}});
function readBody(req, limit){
  return new Promise((ok, bad) => { const parts = []; let n = 0;
    req.on("data", c => { n += c.length; if (n > limit) { bad(new Error("too large")); req.destroy(); } else parts.push(c); });
    req.on("end", () => ok(Buffer.concat(parts))); req.on("error", bad); });
}
const formOf = async req => new URLSearchParams((await readBody(req, 20000)).toString());
const jsonOf = async (req, limit) => JSON.parse((await readBody(req, limit || 1e6)).toString() || "{}");
const escH = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"})[c]);
const pub = u => ({id:u.id, email:u.email, name:u.name, admin:u.admin});
const wait = ms => new Promise(r => setTimeout(r, ms));
const statePath = id => path.join("state", id.replace(/\W/g, "") + ".json");

/* ---------- pages ---------- */
const PAGE_CSS = `:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100svh;background:#0D1426;color:#F4F7FF;font-family:system-ui,"PingFang SC","Microsoft YaHei",sans-serif;padding:16px}
a{color:#9DB4FF}input,select{width:100%;font:inherit;font-size:16px;padding:11px 13px;border-radius:12px;border:1px solid #33415F;background:#151D31;color:#F4F7FF}
button{font:inherit;font-weight:700;padding:11px 16px;border:0;border-radius:12px;background:#E2452B;color:#fff;cursor:pointer}button.alt{background:#26314D}
label{display:block;font-size:13px;color:#B3BDD2;margin-top:12px}label input{margin-top:5px}.e{color:#FF8A6B;font-size:14px}.ok{color:#5BD6A5;font-size:14px}`;
function loginPage(res, o){
  o = o || {}; const reg = o.tab === "register";
  res.writeHead(o.status || 401, {"Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store"});
  res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Trip Planner · ${reg ? "注册 Register" : "登录 Log in"}</title><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/img/icons/icon-180.png?v=2">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="theme-color" content="#0D1426">
<style>${PAGE_CSS}body{display:grid;place-items:center}form{width:100%;max-width:360px}.top{text-align:center}img{width:80px;height:80px;border-radius:20px}h1{font-size:20px;margin:12px 0 4px}
.tabs{display:flex;background:#151D31;border-radius:999px;padding:4px;margin:16px 0 4px}.tabs a{flex:1;text-align:center;padding:8px;border-radius:999px;text-decoration:none;color:#B3BDD2;font-size:14px}.tabs a.on{background:#F4F7FF;color:#0D1426;font-weight:700}
form button{width:100%;margin-top:16px}small{display:block;color:#7F8AA3;font-size:12px;margin-top:4px}</style></head>
<body><form method="post" action="${reg ? "/register" : "/login"}"><div class="top"><img src="/img/icons/icon-192.png" alt=""><h1>AI Trip Planner · AI行程规划</h1></div>
<div class="tabs"><a href="/login" class="${reg ? "" : "on"}">登录 · Log in</a><a href="/register" class="${reg ? "on" : ""}">注册 · Register</a></div>
${reg ? `<label>名字 · Name<input name="name" required maxlength="60" value="${escH(o.name || "")}" autocomplete="name"></label>` : ""}
<label>电邮 · Email<input type="email" name="email" required value="${escH(o.email || "")}" autocomplete="email"></label>
<label>密码 · Password<input type="password" name="password" required minlength="${reg ? 8 : 1}" autocomplete="${reg ? "new-password" : "current-password"}">${reg ? "<small>至少8位 · at least 8 characters</small>" : ""}</label>
${reg ? `<label>邀请码 · Invite code<input name="code" required value="${escH(o.invite || "")}" autocomplete="off"><small>向管理员索取 · ask the organiser for the code</small></label>` : ""}
<button>${reg ? "注册并进入 · Create account" : "登录 · Log in"}</button>${o.msg ? `<p class="e">${escH(o.msg)}</p>` : ""}
${reg ? "" : `<small style="text-align:center;margin-top:14px">忘记密码？请管理员重设 · Forgot it? Ask the organiser to reset it.</small>`}</form><script>if (/^#el=/.test(location.hash)) try { sessionStorage.setItem("tp_el", location.hash); } catch(e) {}</script></body></html>`);
}
function adminPage(res){
  res.writeHead(200, {"Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store"});
  res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin · AI Trip Planner</title>
<style>${PAGE_CSS}.wrap{max-width:980px;margin:0 auto}h1{font-size:22px}h2{font-size:16px;margin:26px 0 8px}.card{background:#151D31;border:1px solid #26314D;border-radius:16px;padding:14px}
.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #26314D;vertical-align:top}
th{color:#B3BDD2;font-weight:600;font-size:12px}td small{color:#7F8AA3;display:block}.acts button{padding:6px 10px;font-size:12px;margin:0 4px 4px 0}.scroll{overflow-x:auto}.off{opacity:.5}.pill{font-size:11px;background:#26314D;border-radius:999px;padding:2px 8px;margin-left:4px}</style></head>
<body><div class="wrap"><p><a href="/">← 回到App · Back to the app</a></p><h1>Admin · AI Trip Planner</h1>
<h2>设置 · Settings</h2><div class="card"><div class="g">
<label>邀请码 · Invite code<input id="invite"></label><label>新行程／天 · New trips / day<input id="l_trips" type="number" min="0"></label>
<label>重做／天 · Day redos / day<input id="l_redos" type="number" min="0"></label><label>识别／天 · Scans / day<input id="l_scans" type="number" min="0"></label><label>语音／天 · Voice / day<input id="l_voice" type="number" min="0"></label></div>
<div class="g"><label>OpenAI API key <span id="k_o" class="pill"></span><input id="openai" type="password" placeholder="留空＝不改 · blank = keep" autocomplete="off"></label>
<label>ElevenLabs API key <span id="k_e" class="pill"></span><input id="eleven" type="password" placeholder="留空＝不改 · blank = keep" autocomplete="off"></label></div>
<p><button id="save">保存设置 · Save settings</button> <span id="smsg"></span></p></div>
<h2>用户 · Users <span id="cnt" class="pill"></span></h2><div class="card scroll"><table><thead><tr><th>用户 · User</th><th>今天 · Today</th><th>累计 · Total</th><th>最近登录 · Last login</th><th></th></tr></thead><tbody id="users"></tbody></table></div><p id="umsg"></p></div>
<script>
const $ = s => document.querySelector(s), E = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]);
const api = (u, b) => fetch(u, b ? {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(b)} : {}).then(r => r.json());
const day = s => s ? new Date(s).toLocaleString() : "—";
async function load(){
  const d = await api("/api/admin");
  $("#invite").value = d.settings.invite; for (const k of ["trips","redos","scans","voice"]) $("#l_"+k).value = d.settings.limits[k];
  $("#k_o").textContent = d.settings.openai || "not set"; $("#k_e").textContent = d.settings.eleven || "not set";
  $("#cnt").textContent = d.users.length;
  $("#users").innerHTML = d.users.map(u => { const t = u.today || {}, T = u.total || {};
    return '<tr class="'+(u.disabled?"off":"")+'"><td><b>'+E(u.name)+'</b>'+(u.admin?'<span class="pill">admin</span>':'')+(u.disabled?'<span class="pill">disabled</span>':'')+'<small>'+E(u.email)+' · '+E((u.created||"").slice(0,10))+' · '+Math.round((u.bytes||0)/1024)+' KB</small></td>'+
      '<td>'+(t.trips||0)+' trips · '+(t.redos||0)+' redos<small>'+(t.scans||0)+' scans · '+(t.voice||0)+' voice</small></td><td>'+(T.trips||0)+' trips<small>'+(T.redos||0)+' redos · '+(T.scans||0)+' scans</small></td><td>'+day(u.lastLogin)+'</td>'+
      '<td class="acts">'+(u.self?'':'<button class="alt" data-a="'+(u.disabled?"enable":"disable")+'" data-id="'+u.id+'">'+(u.disabled?"Enable":"Disable")+'</button><button class="alt" data-a="'+(u.admin?"unadmin":"admin")+'" data-id="'+u.id+'">'+(u.admin?"Remove admin":"Make admin")+'</button>')+
      '<button class="alt" data-a="reset" data-id="'+u.id+'">Reset password</button>'+(u.self?'':'<button data-a="delete" data-id="'+u.id+'">Delete</button>')+'</td></tr>'; }).join("");
  document.querySelectorAll("[data-a]").forEach(b => b.onclick = async () => { const a = b.dataset.a;
    if (a === "delete" && !confirm("Delete this user and all their trips? This can't be undone.")) return;
    if (a === "reset" && !confirm("Give this user a new password? They will be logged out everywhere.")) return;
    const r = await api("/api/admin/user", {id:b.dataset.id, action:a});
    $("#umsg").innerHTML = r.error ? '<span class="e">'+E(r.error.message)+'</span>' : r.password ? '<span class="ok">New password: <b>'+E(r.password)+'</b> (send it to the user; shown only once)</span>' : '<span class="ok">Done.</span>';
    load(); });
}
$("#save").onclick = async () => { const b = {invite:$("#invite").value.trim(), limits:{}}; for (const k of ["trips","redos","scans","voice"]) b.limits[k] = +$("#l_"+k).value;
  if ($("#openai").value.trim()) b.openai = $("#openai").value.trim(); if ($("#eleven").value.trim()) b.eleven = $("#eleven").value.trim();
  const r = await api("/api/admin/settings", b); $("#smsg").innerHTML = r.error ? '<span class="e">'+E(r.error.message)+'</span>' : '<span class="ok">Saved.</span>'; $("#openai").value = $("#eleven").value = ""; load(); };
load();
</script></body></html>`);
}
/* the app page, with this account's synced data inlined so it is in place before the app starts */
async function appPage(res, u){
  let html = await fsp.readFile(path.join(ROOT, "index.html"), "utf8");
  const st = readJSON(statePath(u.id), {rev:0, items:{}});
  const TP = {uid:u.id, name:u.name, email:u.email, admin:u.admin, rev:st.rev, state:st.items, openai:!!OPENAI(), eleven:!!ELEVEN(), voices:SETTINGS.voices || {}};
  html = html.replace("</head>", "<script>window.__TP=" + JSON.stringify(TP).replace(/</g, "\\u003c") + "</script>\n</head>");
  res.writeHead(200, {"Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-cache"}); res.end(html);
}

/* ---------- AI relay with per-user limits ---------- */
async function relayOpenAI(req, res, u){
  const key = OPENAI(); if (!key) return fail(res, 503, "AI 服务还没开通，请联系主办方 · The AI service is not switched on yet; please contact the organiser");
  let body; try { body = await readBody(req, 40 * 1024 * 1024); } catch(e) { return fail(res, 413, "request too large"); }
  const sub = req.url.replace(/^\/api\/openai/, "");
  if (!u.admin) {
    let j = {}; try { j = JSON.parse(body.toString()); } catch(e) {}
    const kind = j && j.text && j.text.format && j.text.format.name, L = SETTINGS.limits, n = use(u);
    if (req.method !== "POST" || sub !== "/v1/responses" || !MODELS.includes(j.model)) return fail(res, 403, "not allowed");
    let count;
    if (kind === "trip_outline") { if (n.trips >= L.trips) return fail(res, 429, LIMIT_MSG.trips); count = "trips"; }
    else if (kind === "trip_day" && req.headers["x-tp-kind"] === "redo") { if (n.redos >= L.redos) return fail(res, 429, LIMIT_MSG.redos); count = "redos"; }
    else if (kind === "trip_day") { if (n.days >= Math.max(1, n.trips) * 15) return fail(res, 429, LIMIT_MSG.trips); count = "days"; }
    else if (kind === "trip_extras") { if (n.extras >= Math.max(1, n.trips) + 2) return fail(res, 429, LIMIT_MSG.trips); count = "extras"; }
    else if (kind === "bookings" || kind === "receipts") { if (n.scans >= L.scans) return fail(res, 429, LIMIT_MSG.scans); count = "scans"; }
    else return fail(res, 403, "not allowed");
    n[count]++; if (u.total[count] !== undefined) { u.total[count]++; saveUsers(); } saveUsage();
  }
  return pipe(res, "https://api.openai.com" + sub, req.method, {Authorization:"Bearer " + key, "Content-Type":req.headers["content-type"] || "application/json"}, body);
}
async function relayEleven(req, res, u){
  const key = ELEVEN(); if (!key) return fail(res, 503, "AI 语音还没开通 · The AI voice is not switched on yet");
  const sub = req.url.replace(/^\/api\/eleven/, "");
  if (!/^\/v[12]\/(voices|text-to-speech\/|speech-to-text)/.test(sub)) return fail(res, 403, "not allowed");
  let body; if (!["GET","HEAD"].includes(req.method)) { try { body = await readBody(req, 25 * 1024 * 1024); } catch(e) { return fail(res, 413, "request too large"); } }
  if (!u.admin && req.method === "POST") { const n = use(u); if (n.voice >= SETTINGS.limits.voice) return fail(res, 429, LIMIT_MSG.voice); n.voice++; u.total.voice++; saveUsage(); }
  const h = {"xi-api-key":key}; if (req.headers["content-type"]) h["Content-Type"] = req.headers["content-type"];
  return pipe(res, "https://api.elevenlabs.io" + sub, req.method, h, body);
}
async function pipe(res, url, method, headers, body){
  try {
    const up = await fetch(url, {method, headers, body});
    const out = {"Cache-Control":"no-store"}; if (up.headers.get("content-type")) out["Content-Type"] = up.headers.get("content-type");
    res.writeHead(up.status, out);
    if (up.body) for await (const chunk of up.body) res.write(chunk);
    res.end();
  } catch(e) { if (!res.headersSent) fail(res, 502, "relay: " + e.message); else res.end(); }
}

/* ---------- routes ---------- */
http.createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/healthz") { res.writeHead(200); return res.end("ok"); }
    if (p === "/login" && req.method === "GET") return loginPage(res, {status:200});
    if (p === "/register" && req.method === "GET") return loginPage(res, {status:200, tab:"register"});
    if (p === "/login" && req.method === "POST") {
      const f = await formOf(req), email = (f.get("email") || "").trim().toLowerCase(), u = USERS.find(x => x.email === email);
      if (!u || !checkPw(u, f.get("password") || "")) { await wait(800); return loginPage(res, {email, msg:"电邮或密码不对 · Wrong email or password"}); }
      if (u.disabled) return loginPage(res, {email, msg:"这个账户已停用 · This account is disabled"});
      u.lastLogin = new Date().toISOString(); saveUsers(); setCookie(res, tokenFor(u), MAX_AGE);
      res.writeHead(303, {Location:"/"}); return res.end();
    }
    if (p === "/register" && req.method === "POST") {
      const f = await formOf(req), name = (f.get("name") || "").trim().slice(0, 60), email = (f.get("email") || "").trim().toLowerCase(), pw = f.get("password") || "", code = (f.get("code") || "").trim();
      const back = msg => loginPage(res, {tab:"register", name, email, invite:code, msg});
      if (!SETTINGS.invite) return back("现在不开放注册 · Registration is closed");
      if (code.toLowerCase() !== SETTINGS.invite.toLowerCase()) { await wait(800); return back("邀请码不对 · Wrong invite code"); }
      if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return back("请填写名字和有效电邮 · Enter your name and a valid email");
      if (pw.length < 8) return back("密码至少8位 · Password needs at least 8 characters");
      if (USERS.some(x => x.email === email)) return back("这个电邮已注册，请直接登录 · That email already has an account; log in instead");
      const u = makeUser(email, name, pw, false); u.lastLogin = new Date().toISOString(); saveUsers();
      setCookie(res, tokenFor(u), MAX_AGE); res.writeHead(303, {Location:"/"}); return res.end();
    }
    if (p === "/logout") { setCookie(res, "", 0); if (req.method === "POST") return json(res, 200, {ok:true}); res.writeHead(303, {Location:"/login"}); return res.end(); }

    const u = userOf(req);
    if (!u && !OPEN(p)) {
      if (p.startsWith("/api/")) return fail(res, 401, "login");
      return loginPage(res);
    }
    if (p === "/api/config") return json(res, 200, {server:true, openai:!!OPENAI(), eleven:!!ELEVEN()});
    if (p === "/api/me") { const n = use(u); return json(res, 200, Object.assign(pub(u), {today:n, limits:SETTINGS.limits})); }
    if (p === "/api/password" && req.method === "POST") {
      const b = await jsonOf(req); if (!checkPw(u, b.old || "")) { await wait(800); return fail(res, 403, "当前密码不对 · Current password is wrong"); }
      if (String(b.new || "").length < 8) return fail(res, 400, "新密码至少8位 · New password needs at least 8 characters");
      u.salt = crypto.randomBytes(16).toString("hex"); u.hash = hashPw(b.new, u.salt); saveUsers(); setCookie(res, tokenFor(u), MAX_AGE); return json(res, 200, {ok:true});
    }
    /* synced app data: {items:{key: value|null}} merged last-write-wins per key */
    if (p === "/api/state" && req.method === "POST") {
      let b; try { b = await jsonOf(req, STATE_CAP); } catch(e) { return fail(res, 413, "too large"); }
      const st = readJSON(statePath(u.id), {rev:0, items:{}});
      for (const [k, v] of Object.entries(b.items || {})) { if (!/^tripai:/.test(k)) continue; if (v === null) delete st.items[k]; else st.items[k] = String(v); }
      if (JSON.stringify(st.items).length > STATE_CAP) return fail(res, 413, "账户空间已满 · Account storage is full");
      st.rev++; await writeJSON(statePath(u.id), st); return json(res, 200, {rev:st.rev});
    }
    if (p.startsWith("/api/openai/")) return relayOpenAI(req, res, u);
    if (p.startsWith("/api/eleven/")) return relayEleven(req, res, u);
    if (p === "/admin" || p.startsWith("/api/admin")) {
      if (!u.admin) return fail(res, 403, "admins only");
      if (p === "/admin") return adminPage(res);
      const tail = k => k ? "••••" + k.slice(-4) : "";
      if (p === "/api/admin" ) { use(u); return json(res, 200, {settings:{invite:SETTINGS.invite, limits:SETTINGS.limits, openai:tail(OPENAI()), eleven:tail(ELEVEN())},
        users:USERS.map(x => { let bytes = 0; try { bytes = fs.statSync(path.join(DATA, statePath(x.id))).size; } catch(e) {}
          return Object.assign(pub(x), {created:x.created, lastLogin:x.lastLogin, disabled:x.disabled, total:x.total, today:USAGE.users[x.id] || {}, bytes, self:x.id === u.id}); })
          .sort((a, b) => (b.lastLogin || "").localeCompare(a.lastLogin || ""))}); }
      if (p === "/api/admin/settings" && req.method === "POST") {
        const b = await jsonOf(req);
        if (typeof b.invite === "string") SETTINGS.invite = b.invite.slice(0, 60);
        if (b.limits) for (const k of Object.keys(DEF_LIMITS)) if (Number.isFinite(+b.limits[k]) && +b.limits[k] >= 0) SETTINGS.limits[k] = Math.round(+b.limits[k]);
        if (typeof b.openai === "string" && b.openai.trim()) SETTINGS.openai = b.openai.trim();
        if (typeof b.eleven === "string" && b.eleven.trim()) SETTINGS.eleven = b.eleven.trim();
        if (b.voices && typeof b.voices === "object") { const v = {}; for (const k of Object.keys(b.voices).slice(0, 12)) if (/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(k) && /^[A-Za-z0-9]{10,40}$/.test(String(b.voices[k]))) v[k] = String(b.voices[k]); SETTINGS.voices = Object.assign({}, SETTINGS.voices, v); }
        await saveSettings(); return json(res, 200, {ok:true});
      }
      if (p === "/api/admin/user" && req.method === "POST") {
        const b = await jsonOf(req), x = USERS.find(y => y.id === b.id); if (!x) return fail(res, 404, "no such user");
        if (x.id === u.id && b.action !== "reset") return fail(res, 400, "not on your own account");
        if (b.action === "disable") x.disabled = true; else if (b.action === "enable") x.disabled = false;
        else if (b.action === "admin") x.admin = true; else if (b.action === "unadmin") x.admin = false;
        else if (b.action === "reset") { const pw = newPassword(); x.salt = crypto.randomBytes(16).toString("hex"); x.hash = hashPw(pw, x.salt); await saveUsers(); if (x.id === u.id) setCookie(res, tokenFor(x), MAX_AGE); return json(res, 200, {ok:true, password:pw}); }
        else if (b.action === "delete") { USERS = USERS.filter(y => y.id !== x.id); try { fs.unlinkSync(path.join(DATA, statePath(x.id))); } catch(e) {} }
        else return fail(res, 400, "unknown action");
        await saveUsers(); return json(res, 200, {ok:true});
      }
      return fail(res, 404, "not found");
    }
    if (p === "/" || p === "/index.html") return appPage(res, u);
    /* other static files; never the server's own files, data or dotfiles */
    const f = path.normalize(path.join(ROOT, p));
    if (!f.startsWith(ROOT + path.sep) || /[\\/]\.|^[\\/](server\.js|package(-lock)?\.json|node_modules)/.test(f.slice(ROOT.length))) { res.writeHead(404); return res.end(); }
    fs.readFile(f, (e, d) => {
      if (e) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, {"Content-Type":TYPES[path.extname(f)] || "application/octet-stream", "Cache-Control":/sw\.js$/.test(f) ? "no-cache" : "public, max-age=3600"});
      res.end(d);
    });
  } catch(e) { console.error(e); if (!res.headersSent) fail(res, 500, "server error"); else res.end(); }
}).listen(PORT, () => console.log("AI Trip Planner on :" + PORT + " · data " + DATA + " · users " + USERS.length + " · openai " + !!OPENAI() + " · eleven " + !!ELEVEN()));
