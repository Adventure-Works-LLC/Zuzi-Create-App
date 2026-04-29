/**
 * Password verification.
 *
 * One-user app. The single password's bcrypt hash lives in the `ZUZI_PASSWORD_HASH` env
 * var (sealed in Railway). Hash with `npm run hash-password` (see scripts/hash-password.ts).
 */

import bcrypt from "bcryptjs";

export async function verifyPassword(plaintext: string): Promise<boolean> {
  const hash = process.env.ZUZI_PASSWORD_HASH;
  if (!hash) {
    throw new Error("ZUZI_PASSWORD_HASH env var is missing");
  }
  if (!plaintext || typeof plaintext !== "string") return false;
  return bcrypt.compare(plaintext, hash);
}
