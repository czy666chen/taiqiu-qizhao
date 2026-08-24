import { createHmac, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";

const args = process.argv.slice(2);
const environment = args.includes("--env") ? args[args.indexOf("--env") + 1] : "";
const displayUsername = args.find((arg, index) => index !== args.indexOf("--env") + 1 && !arg.startsWith("--"))?.trim() ?? "";
const normalizedUsername = displayUsername.toLowerCase();

if (!["preview", "production"].includes(environment) || !/^[a-z0-9_]{3,24}$/.test(normalizedUsername)) {
  console.error("Usage: npm run admin:create -- <username> --env preview|production");
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
  const executable = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(
    executable,
    ["wrangler", "d1", "execute", database, "--remote", "--env", environment, "--json", "--command", sql],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, WRANGLER_WRITE_LOGS: "false", WRANGLER_LOG_PATH: ".wrangler/logs" },
    },
  );
  if (result.status !== 0) throw new Error(result.stderr.trim() || "Wrangler command failed");
  return JSON.parse(result.stdout);
}

const password = await readHidden("Password (6-64 characters): ");
if (typeof password !== "string" || password.length < 6 || password.length > 64) {
  throw new Error("Password must contain 6 to 64 characters");
}
const confirmation = await readHidden("Confirm password: ");
if (password !== confirmation) throw new Error("Passwords do not match");
const hmacKey = await readHidden("PASSWORD_HMAC_KEY: ");
if (typeof hmacKey !== "string" || hmacKey.length < 16) throw new Error("PASSWORD_HMAC_KEY is too short");

const database = environment === "preview" ? "hei8-r3-preview" : "hei8-r3-production-v2";
const lookup = runWrangler(
  database,
  `SELECT 1 AS found FROM admin_users WHERE normalized_username = '${normalizedUsername}'`,
);
if (lookup?.[0]?.results?.[0]?.found === 1) throw new Error("Administrator already exists");

const digest = createHmac("sha256", hmacKey)
  .update(`password-v1\0${normalizedUsername}\0${password}`)
  .digest("hex");
runWrangler(
  database,
  `INSERT INTO admin_users (id, normalized_username, display_username, password_digest)
   VALUES ('${randomUUID()}', '${normalizedUsername}', '${displayUsername}', '${digest}')`,
);
console.log(`Administrator ${displayUsername} created in ${environment}.`);
