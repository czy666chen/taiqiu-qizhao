import { createHmac, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const environment = args.includes("--env") ? args[args.indexOf("--env") + 1] : "";
const username = args.find((arg, index) => index !== args.indexOf("--env") + 1 && !arg.startsWith("--"))?.trim().toLowerCase() ?? "";

if (!["preview", "production"].includes(environment) || !/^[a-z0-9_]{3,24}$/.test(username)) {
  console.error("Usage: npm run admin:reset-password -- <username> --env preview|production");
  process.exit(2);
}

function readHidden(prompt) {
  if (!process.stdin.isTTY) throw new Error("This command requires an interactive terminal");
  process.stdout.write(prompt);
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const reader = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => reader.question("", (answer) => {
    reader.close();
    process.stdout.write("\n");
    resolve(answer);
  }));
}

function runWrangler(database, sql) {
  const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [wrangler, "d1", "execute", database, "--remote", "--env", environment, "--json", "--command", sql],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, WRANGLER_WRITE_LOGS: "false", WRANGLER_LOG_PATH: ".wrangler/logs" },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.trim() || result.stdout?.trim() || "Wrangler command failed");
  return JSON.parse(result.stdout);
}

const password = await readHidden("New password (6-64 characters): ");
if (typeof password !== "string" || password.length < 6 || password.length > 64) {
  throw new Error("Password must contain 6 to 64 characters");
}
const confirmation = await readHidden("Confirm password: ");
if (password !== confirmation) throw new Error("Passwords do not match");
const hmacKey = await readHidden("PASSWORD_HMAC_KEY: ");
if (typeof hmacKey !== "string" || hmacKey.length < 16) throw new Error("PASSWORD_HMAC_KEY is too short");

const database = environment === "preview" ? "hei8-r3-preview" : "hei8-r3-production-v2";
const lookup = runWrangler(database, `SELECT id FROM admin_users WHERE normalized_username = '${username}'`);
const adminUserId = lookup?.[0]?.results?.[0]?.id;
if (typeof adminUserId !== "string") throw new Error("Administrator not found");

const digest = createHmac("sha256", hmacKey)
  .update(`password-v1\0${username}\0${password}`)
  .digest("hex");
const now = Date.now();
runWrangler(
  database,
  `UPDATE admin_users
      SET password_digest = '${digest}', password_version = password_version + 1, updated_at = ${now}
    WHERE id = '${adminUserId}';
   DELETE FROM admin_sessions WHERE admin_user_id = '${adminUserId}';
   INSERT INTO admin_audit_events
     (id, action, target_type, target_id, outcome, request_id, metadata_json, created_at)
   VALUES
     ('${randomUUID()}', 'reset_password', 'admin_user', '${adminUserId}', 'success',
      'admin-cli:${randomUUID()}', '{"source":"admin_cli"}', ${now});`,
);

console.log(`Administrator password reset completed for ${username} in ${environment}; all previous sessions were revoked.`);
