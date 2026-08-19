const http = require("http");
const https = require("https");
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const ENV_FILE = path.join(process.cwd(), ".env");
loadEnv(ENV_FILE);

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3001);
const TOKEN = process.env.CICD_TOKEN || "";
const REPO = process.env.GITHUB_REPO || "nguynninh/vlive-docs";
const DEPLOY_SCRIPT = process.env.DEPLOY_SCRIPT || path.join(process.cwd(), "scripts/deploy.sh");
const LOG_FILE = process.env.LOG_FILE || path.join(process.cwd(), "deploy.log");

let running = false;

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

function githubJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "vlive-docs-server",
        },
      }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`GitHub returned ${res.statusCode}`));
            return;
          }
          resolve(JSON.parse(body));
        });
      })
      .on("error", reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4096) req.destroy();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function authed(req) {
  if (!TOKEN || req.url === "/health") return true;
  const auth = req.headers.authorization || "";
  const cookie = req.headers.cookie || "";
  return auth === `Bearer ${TOKEN}` || cookie.split(/;\s*/).includes(`cicd_token=${TOKEN}`);
}

function send(res, status, body, type = "text/html; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function normalizeTag(value) {
  const tag = String(value || "").trim().replace(/^\/+/, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/.test(tag)) return "";
  return tag;
}

function config() {
  return {
    appDir: process.env.APP_DIR || "/home/vtvlive/vlive-docs",
    pm2App: process.env.PM2_APP || "vlive-docs",
  };
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    }).trim();
  } catch (error) {
    return "";
  }
}

function gitInfo(appDir) {
  const exists = fs.existsSync(appDir);
  const isRepo = fs.existsSync(path.join(appDir, ".git"));
  if (!exists || !isRepo) {
    return {
      exists,
      isRepo,
      path: appDir,
      branch: "-",
      tag: "-",
      commit: "-",
      status: exists ? "not a git repo" : "path missing",
    };
  }

  return {
    exists,
    isRepo,
    path: appDir,
    branch: run("git", ["-C", appDir, "branch", "--show-current"]) || "(detached)",
    tag: run("git", ["-C", appDir, "describe", "--tags", "--exact-match", "HEAD"]) || "",
    commit: run("git", ["-C", appDir, "rev-parse", "--short", "HEAD"]) || "",
    status: run("git", ["-C", appDir, "status", "--short"]) || "clean",
  };
}

function pm2Apps() {
  try {
    return JSON.parse(run("pm2", ["jlist"]) || "[]").map((app) => {
      const env = app.pm2_env || {};
      return {
        id: env.pm_id,
        name: app.name,
        status: env.status,
        cwd: env.pm_cwd || "",
        port: env.PORT || "",
        restarts: env.restart_time,
      };
    });
  } catch (error) {
    return [];
  }
}

function statusInfo() {
  const cfg = config();
  const apps = pm2Apps();
  return {
    cfg,
    cicd: {
      path: process.cwd(),
      deployScript: DEPLOY_SCRIPT,
      logFile: LOG_FILE,
      url: `http://${HOST}:${PORT}`,
      status: "running",
    },
    target: gitInfo(cfg.appDir),
    apps,
    selectedApp: apps.find((app) => app.name === cfg.pm2App),
  };
}

function saveConfig(next) {
  const current = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
  const values = Object.fromEntries(current.split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    return match ? [match[1], match[2]] : [];
  }).filter((item) => item.length));

  values.APP_DIR = next.appDir;
  values.PM2_APP = next.pm2App;
  process.env.APP_DIR = next.appDir;
  process.env.PM2_APP = next.pm2App;

  const keys = ["HOST", "PORT", "CICD_TOKEN", "GITHUB_REPO", "APP_DIR", "PM2_APP", "DEPLOY_SCRIPT", "LOG_FILE"];
  fs.writeFileSync(ENV_FILE, `${keys.map((key) => `${key}=${values[key] || process.env[key] || ""}`).join("\n")}\n`, { mode: 0o600 });
}

async function releases() {
  const items = await githubJson(`https://api.github.com/repos/${REPO}/releases?per_page=50`);
  return items.map((item) => ({
    tag: item.tag_name,
    name: item.name || item.tag_name,
    date: item.published_at || item.created_at || "",
    url: item.html_url,
  }));
}

function runDeploy(tag) {
  running = true;
  fs.appendFileSync(LOG_FILE, `\n== ${new Date().toISOString()} deploy ${tag} ==\n`);
  const child = spawn(DEPLOY_SCRIPT, [tag], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (data) => fs.appendFileSync(LOG_FILE, data));
  child.stderr.on("data", (data) => fs.appendFileSync(LOG_FILE, data));
  child.on("close", (code) => {
    fs.appendFileSync(LOG_FILE, `== finished with code ${code} ==\n`);
    running = false;
  });
}

function loginPage(error = "") {
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CICD Login</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#f6f7f9;color:#15181c}
    main{max-width:360px;margin:15vh auto;padding:20px}
    input,button{box-sizing:border-box;width:100%;font:inherit;padding:11px;margin-top:10px;border-radius:6px}
    input{border:1px solid #c9ced6}
    button{border:0;background:#1769e0;color:white;cursor:pointer}
    .err{color:#9b1c1c}
  </style>
</head>
<body>
  <main>
    <h1>CICD Login</h1>
    ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
    <form method="post" action="/login">
      <input name="token" type="password" placeholder="Token" autofocus>
      <button>Login</button>
    </form>
  </main>
</body>
</html>`;
}

async function dashboard(message = "", isError = false) {
  let rows = "";
  let releaseError = "";

  try {
    rows = (await releases()).map((release) => `
      <tr>
        <td><a href="${escapeHtml(release.url)}" target="_blank" rel="noreferrer">${escapeHtml(release.tag)}</a></td>
        <td>${escapeHtml(release.name)}</td>
        <td>${escapeHtml(release.date)}</td>
        <td>
          <form method="post" action="/run">
            <input type="hidden" name="tag" value="${escapeHtml(release.tag)}">
            <button ${running ? "disabled" : ""}>Run</button>
          </form>
        </td>
      </tr>`).join("");
  } catch (error) {
    releaseError = `Không tải được GitHub releases: ${error.message}`;
  }

  const log = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, "utf8").slice(-12000) : "";

  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VLive Docs CICD</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#f6f7f9;color:#15181c}
    main{max-width:1100px;margin:0 auto;padding:32px 18px}
    h1{font-size:28px;margin:0 0 18px}
    h2{font-size:18px;margin:24px 0 10px}
    form.inline{display:flex;gap:8px;margin:0 0 18px}
    input{font:inherit;padding:10px 12px;border:1px solid #c9ced6;border-radius:6px;min-width:220px}
    button{font:inherit;padding:10px 14px;border:0;border-radius:6px;background:#1769e0;color:white;cursor:pointer}
    button:disabled{background:#98a2b3;cursor:not-allowed}
    table{width:100%;border-collapse:collapse;background:white;border:1px solid #e1e5ea}
    th,td{text-align:left;padding:12px;border-bottom:1px solid #e1e5ea;vertical-align:top}
    th{background:#eef1f5}
    .bar{margin:0 0 16px;padding:10px 12px;border-radius:6px;background:#e9f6ee;color:#155724}
    .err{background:#fff0f0;color:#9b1c1c}
    pre{white-space:pre-wrap;background:#101418;color:#d6e2ee;padding:14px;border-radius:6px;max-height:360px;overflow:auto}
    a{color:#1769e0}
    .grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:0 0 18px}
    .cell{background:white;border:1px solid #e1e5ea;padding:10px;border-radius:6px}
    .label{font-size:12px;color:#667085;margin-bottom:4px}
    .value{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
    .ok{color:#067647;font-weight:700}.bad{color:#b42318;font-weight:700}
    .config{display:grid;grid-template-columns:2fr 1fr auto;gap:8px;margin:0 0 18px}
    .config input{width:100%;box-sizing:border-box}
    @media (max-width: 900px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.config{grid-template-columns:1fr}}
    @media (max-width: 680px){form.inline{display:block}input,button{width:100%;box-sizing:border-box;margin-bottom:8px}table{font-size:14px}.grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <main>
    <h1>VLive Docs CICD</h1>
    ${message ? `<div class="bar ${isError ? "err" : ""}">${escapeHtml(message)}</div>` : ""}
    ${releaseError ? `<div class="bar err">${escapeHtml(releaseError)}</div>` : ""}
    ${statusPanel()}
    <form class="inline" method="post" action="/run">
      <input name="tag" placeholder="/v1.1.1" autocomplete="off" required>
      <button ${running ? "disabled" : ""}>Run</button>
    </form>
    <table>
      <thead><tr><th>Tag</th><th>Release</th><th>Published</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4">Chưa có release để hiển thị.</td></tr>`}</tbody>
    </table>
    <h2>Deploy log</h2>
    <pre>${escapeHtml(log)}</pre>
  </main>
</body>
</html>`;
}

function statusPanel() {
  const info = statusInfo();
  const appRows = info.apps.map((app) => `
    <tr>
      <td>${escapeHtml(app.name)}</td>
      <td class="${app.status === "online" ? "ok" : "bad"}">${escapeHtml(app.status)}</td>
      <td>${escapeHtml(app.port || "-")}</td>
      <td>${escapeHtml(app.cwd || "-")}</td>
      <td>${escapeHtml(app.restarts)}</td>
    </tr>`).join("");

  return `
    <h2>Status</h2>
    <div class="grid">
      <div class="cell"><div class="label">CICD server</div><div class="value ok">${escapeHtml(info.cicd.status)}</div></div>
      <div class="cell"><div class="label">CICD path</div><div class="value">${escapeHtml(info.cicd.path)}</div></div>
      <div class="cell"><div class="label">Deploy script</div><div class="value">${escapeHtml(info.cicd.deployScript)}</div></div>
      <div class="cell"><div class="label">Log file</div><div class="value">${escapeHtml(info.cicd.logFile)}</div></div>
      <div class="cell"><div class="label">Deploy app</div><div class="value ${info.selectedApp?.status === "online" ? "ok" : "bad"}">${escapeHtml(info.cfg.pm2App)} ${escapeHtml(info.selectedApp?.status || "not found")}</div></div>
      <div class="cell"><div class="label">Deploy path</div><div class="value ${info.target.exists && info.target.isRepo ? "ok" : "bad"}">${escapeHtml(info.target.path)}</div></div>
      <div class="cell"><div class="label">Current tag</div><div class="value">${escapeHtml(info.target.tag || "-")}</div></div>
      <div class="cell"><div class="label">Branch</div><div class="value">${escapeHtml(info.target.branch)}</div></div>
      <div class="cell"><div class="label">Commit</div><div class="value">${escapeHtml(info.target.commit || "-")}</div></div>
      <div class="cell"><div class="label">Git status</div><div class="value">${escapeHtml(info.target.status)}</div></div>
    </div>
    <form class="config" method="post" action="/config">
      <input name="appDir" value="${escapeHtml(info.cfg.appDir)}" placeholder="/home/vtvlive/vlive-docs" required>
      <input name="pm2App" value="${escapeHtml(info.cfg.pm2App)}" placeholder="vlive-docs" required>
      <button>Save path</button>
    </form>
    <table>
      <thead><tr><th>PM2 app</th><th>Status</th><th>Port</th><th>Path</th><th>Restarts</th></tr></thead>
      <tbody>${appRows || `<tr><td colspan="5">Không đọc được PM2 app.</td></tr>`}</tbody>
    </table>`;
}

http.createServer(async (req, res) => {
  try {
    if (req.url === "/health") return send(res, 200, "ok", "text/plain; charset=utf-8");

    if (req.url === "/login" && req.method === "POST") {
      const params = new URLSearchParams(await readBody(req));
      if (params.get("token") === TOKEN) {
        res.writeHead(303, {
          "Set-Cookie": `cicd_token=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`,
          Location: "/",
        });
        return res.end();
      }
      return send(res, 401, loginPage("Sai token."));
    }

    if (!authed(req)) return send(res, 401, loginPage());

    if (req.url === "/config" && req.method === "POST") {
      const params = new URLSearchParams(await readBody(req));
      const appDir = String(params.get("appDir") || "").trim();
      const pm2App = String(params.get("pm2App") || "").trim();
      if (!appDir.startsWith("/") || !/^[A-Za-z0-9._/-]+$/.test(appDir)) {
        return send(res, 400, await dashboard("APP_DIR không hợp lệ.", true));
      }
      if (!/^[A-Za-z0-9._-]{1,80}$/.test(pm2App)) {
        return send(res, 400, await dashboard("PM2_APP không hợp lệ.", true));
      }
      saveConfig({ appDir, pm2App });
      return send(res, 200, await dashboard("Đã lưu path deploy."));
    }

    if (req.url === "/run" && req.method === "POST") {
      const params = new URLSearchParams(await readBody(req));
      const tag = normalizeTag(params.get("tag"));
      if (!tag) return send(res, 400, await dashboard("Tag không hợp lệ.", true));
      if (running) return send(res, 409, await dashboard("Đang deploy, chờ lượt hiện tại xong.", true));
      runDeploy(tag);
      return send(res, 202, await dashboard(`Đã nhận lệnh deploy ${tag}.`));
    }

    return send(res, 200, await dashboard());
  } catch (error) {
    return send(res, 500, error.stack || error.message, "text/plain; charset=utf-8");
  }
}).listen(PORT, HOST, () => {
  console.log(`vlive-docs-server listening on http://${HOST}:${PORT}`);
});
