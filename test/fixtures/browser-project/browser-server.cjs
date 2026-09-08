const { createServer } = require("node:http");
const { execFileSync } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const runtime = JSON.parse(readFileSync("tools/browser-runtime.json", "utf8"));
const sessions = new Set();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const literal = (value) =>
  `convert_from(decode('${Buffer.from(value).toString("hex")}','hex'),'UTF8')`;
const escaped = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const query = (sql) => {
  if (!process.env.DATABASE_URL)
    throw new Error("Declared browser database URL is unavailable in this command environment");
  return execFileSync(
    runtime.psql,
    [
      "-X",
      "-w",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      process.env.DATABASE_URL,
      "-c",
      "SET statement_timeout='3s'; SET search_path TO pg_catalog,public; " + sql,
    ],
    {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 16384,
      env: {
        PATH: "/usr/bin:/bin",
        PGCONNECT_TIMEOUT: "2",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
};
const server = createServer(async (request, response) => {
  const html = (status, body) => {
    response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
    response.end(body);
  };
  if (request.url === "/health") {
    response.writeHead(200);
    response.end("ready");
    return;
  }
  if (request.url === "/login" && request.method === "GET") {
    html(
      200,
      '<h1>Sign in</h1><form method="post" action="/login"><label>Username<input name="username" autocomplete="username"></label><label>Password<input name="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form>',
    );
    return;
  }
  if (request.url === "/login" && request.method === "POST") {
    let body = "";
    for await (const part of request) {
      body += part.toString();
      if (body.length > 4096) {
        html(413, "Too large");
        return;
      }
    }
    const fields = new URLSearchParams(body);
    try {
      // These are declared disposable application fixtures, never operator credentials.
      query(
        `CREATE TABLE IF NOT EXISTS public.e2e_users(username text PRIMARY KEY, password_hash text NOT NULL); INSERT INTO public.e2e_users VALUES('fixture-user','${hash("fixture-password")}') ON CONFLICT(username) DO NOTHING`,
      );
      const authenticated = query(
        `SELECT count(*) FROM public.e2e_users WHERE username=${literal(fields.get("username") ?? "")} AND password_hash=${literal(hash(fields.get("password") ?? ""))}`,
      );
      if (authenticated !== "1") {
        html(401, "<h1>Authentication failed</h1>");
        return;
      }
      const token = randomUUID();
      sessions.add(token);
      response.writeHead(303, {
        Location: "/dashboard",
        "Set-Cookie": `fixture_session=${token}; HttpOnly; SameSite=Strict; Path=/`,
      });
      response.end();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown database error";
      process.stderr.write(`Browser fixture authentication failed: ${detail}\n`);
      html(503, `<h1>Authentication unavailable</h1><pre>${escaped(detail)}</pre>`);
    }
    return;
  }
  if (request.url === "/dashboard") {
    const token = (request.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("fixture_session="))
      ?.slice("fixture_session=".length);
    if (!token || !sessions.has(token)) {
      html(401, "Sign in required");
      return;
    }
    try {
      const database = query("SELECT current_database()"),
        output = readFileSync(
          join(process.env.EPICD_BROWSER_SOURCE_ROOT, "source.txt"),
          "utf8",
        ).trim();
      html(
        200,
        `<h1>Welcome ${escaped(output)}</h1><span data-testid="database-name">${escaped(database)}</span>`,
      );
    } catch {
      html(503, "Database unavailable");
    }
    return;
  }
  html(404, "Not found");
});
server.listen(4173, "127.0.0.1");
