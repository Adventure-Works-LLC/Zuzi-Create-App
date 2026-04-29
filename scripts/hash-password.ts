/**
 * One-shot: hash a plaintext password into a bcrypt string suitable for the
 * ZUZI_PASSWORD_HASH env var. Reads plaintext from argv[2] or PASSWORD env.
 *
 * Run:
 *   npm run hash-password -- 'her-password-here'
 *   PASSWORD='her-password' npm run hash-password
 *
 * The output goes to stdout. Do NOT commit it. Paste into Railway sealed env var.
 */

import bcrypt from "bcryptjs";

const SALT_ROUNDS = 12;

async function main() {
  const fromArgv = process.argv[2];
  const fromEnv = process.env.PASSWORD;
  const plaintext = fromArgv ?? fromEnv;

  if (!plaintext) {
    console.error(
      "Usage:\n  npm run hash-password -- 'her-password-here'\n  PASSWORD='her-password' npm run hash-password",
    );
    process.exit(1);
  }
  if (plaintext.length < 8) {
    console.error("Password must be at least 8 characters");
    process.exit(1);
  }

  const hash = await bcrypt.hash(plaintext, SALT_ROUNDS);
  // Bare hash (for Railway sealed env vars — no expansion happens there).
  console.log(hash);
  // Backslash-escaped form for local .env. Without escaping, Next.js's @next/env
  // (dotenv-expand) consumes the `$2b$12$` salt prefix as variable references and
  // mangles the hash. Single-quoting does NOT prevent this.
  const escaped = hash.replace(/\$/g, "\\$");
  console.error(""); // separate the .env-form from the bare hash on stderr
  console.error("# For local .env (safe from dotenv-expand):");
  console.error(`ZUZI_PASSWORD_HASH=${escaped}`);
}

main().catch((e) => {
  console.error("hash-password failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
