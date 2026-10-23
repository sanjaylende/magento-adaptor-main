// A pretend LTX for automated tests: the two calls the staff console makes (POST /api/v1/auth/login and GET /api/v1/auth/me), with the same
// field names LTX answers with. Nothing here reaches a real LTX, and every password below is made up for the tests.
const http = require("http");
const crypto = require("crypto");

const PORT = 45125;
const TENANT = "00000000-0000-0000-0000-0000000000aa";
const ENV = { ADMIN_AUTH_BASE_URL: `http://127.0.0.1:${PORT}`, FLIPICK_TENANT_ID: TENANT };

// email -> account. `role` and `tenant_id` are what the console's access rule looks at.
const ACCOUNTS = {
  "staff@test.local": { password: "staff-password-1", id: "u-super", role: "superadmin", tenant_id: "00000000-0000-0000-0000-000000000001" },
  "tenant-admin@test.local": { password: "tenant-password-1", id: "u-tenant", role: "admin", tenant_id: TENANT },
  "other-admin@test.local": { password: "other-password-1", id: "u-other", role: "admin", tenant_id: "00000000-0000-0000-0000-0000000000bb" },
  "member@test.local": { password: "member-password-1", id: "u-member", role: "member", tenant_id: TENANT },
};

function start() {
  const tokens = new Map(); // token -> email
  const calls = { login: [], me: 0 };
  const state = { down: false }; // true: answer 503 to everything, like an LTX outage
  const publicUser = (email) => { const { password, ...rest } = ACCOUNTS[email]; return { ...rest, email, full_name: email }; }; // eslint-disable-line no-unused-vars
  const server = http.createServer((req, res) => {
    const send = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (state.down) return send(503, { error: "down" });
    if (req.method === "POST" && req.url === "/api/v1/auth/login") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const { email, password } = JSON.parse(raw || "{}");
        calls.login.push({ email, password });
        const account = ACCOUNTS[String(email || "").toLowerCase()];
        if (!account || account.password !== password) return send(401, { error: "Invalid credentials" });
        const token = crypto.randomBytes(24).toString("hex");
        tokens.set(token, String(email).toLowerCase());
        send(200, { token, user: publicUser(String(email).toLowerCase()) });
      });
      return;
    }
    if (req.method === "GET" && req.url === "/api/v1/auth/me") {
      calls.me += 1;
      const email = tokens.get(String(req.headers.authorization || "").replace(/^Bearer /, ""));
      return email ? send(200, publicUser(email)) : send(401, { error: "Unauthorized" });
    }
    send(404, { error: "not found" });
  });
  server.unref(); // does not keep a finished test process alive
  server.listen(PORT, "127.0.0.1");
  // revoke(email): every token of that account stops working at once, like a password change or deactivation in LTX.
  server.revoke = (email) => { for (const [t, e] of tokens) if (e === email) tokens.delete(t); };
  server.calls = calls;
  server.state = state;
  return server;
}

module.exports = { start, ENV, ACCOUNTS, TENANT, PORT };
