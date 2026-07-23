#!/usr/bin/env node
/**
 * Redact private-key material from local AI-session artifacts.
 *
 * Scans Claude Code transcripts, Claude project memory, Codex session storage,
 * and shell history for hex strings that DERIVE to one of the known wallet
 * addresses below, and replaces each occurrence with [REDACTED-PRIVATE-KEY].
 * Transaction hashes and other 64-hex values are left alone: a string is only
 * redacted if privateKeyToAccount(string) yields a target address, so nothing
 * public is touched.
 *
 * Run it YOURSELF, from the repo root, ideally after closing any live Claude
 * Code session (the live session file is rewritten in place, inode preserved,
 * but closing first removes even the small append race):
 *
 *   node tools/security/scrub-key-references.mjs           # dry run: report only
 *   node tools/security/scrub-key-references.mjs --write   # actually redact
 *
 * What this does NOT do, stated plainly: it cannot un-transmit anything. The
 * conversation content already left this machine when it was sent to the model
 * providers, and Time Machine or other backups may hold pre-scrub copies.
 * Local scrubbing shrinks the local attack surface; ROTATING THE KEY is the
 * only real fix and remains scheduled.
 */

import { createRequire } from "node:module";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Resolve viem from the workspace without needing a root dependency.
const require = createRequire(join(process.cwd(), "packages/procurer/package.json"));
const { privateKeyToAccount } = require("viem/accounts");

/** Addresses whose private keys must never survive in a local file. */
const TARGET_ADDRESSES = new Set([
  "0xc0296012cfbb0e6df5da7158b65dbc46dd9650e0", // Firm wallet (exposure documented in F1.md)
  "0xe689d26da43b7a8f15e2dd59656e34652e42c945" // MetaMask test wallet
]);

const REPLACEMENT = "[REDACTED-PRIVATE-KEY]";
const WRITE = process.argv.includes("--write");
const HOME = homedir();

/** Places AI sessions and prompts persist on this machine. */
const ROOTS = [
  join(HOME, ".claude", "projects"), // Claude Code transcripts + auto-memory
  join(HOME, ".claude.json"), // Claude Code prompt history
  join(HOME, ".codex"), // Codex CLI sessions/history
  join(HOME, ".zsh_history"),
  join(HOME, ".bash_history")
];

const MAX_BYTES = 512 * 1024 * 1024;
// Standalone 64-hex tokens, with or without 0x. The \b guards mean a 64-char
// window inside a longer hex run (signatures, calldata) never matches.
const CANDIDATE = /\b(?:0x)?[0-9a-fA-F]{64}\b/g;

function* walk(path) {
  let info;
  try {
    info = statSync(path);
  } catch {
    return;
  }
  if (info.isFile()) {
    if (info.size <= MAX_BYTES) yield path;
    return;
  }
  if (!info.isDirectory()) return;
  let entries;
  try {
    entries = readdirSync(path);
  } catch {
    return;
  }
  for (const entry of entries) yield* walk(join(path, entry));
}

/** True only when the token is a private key for one of the target wallets. */
const verdictCache = new Map();
function isTargetKey(token) {
  const normalised = token.toLowerCase().replace(/^0x/, "");
  if (verdictCache.has(normalised)) return verdictCache.get(normalised);
  let verdict = false;
  try {
    verdict = TARGET_ADDRESSES.has(privateKeyToAccount(`0x${normalised}`).address.toLowerCase());
  } catch {
    /* not a valid key at all */
  }
  verdictCache.set(normalised, verdict);
  return verdict;
}

let filesTouched = 0;
let totalRedactions = 0;

for (const root of ROOTS) {
  for (const file of walk(root)) {
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue; // binary or unreadable; keys pasted into chats are in text files
    }
    let count = 0;
    const scrubbed = content.replace(CANDIDATE, (token) => {
      if (!isTargetKey(token)) return token;
      count += 1;
      return REPLACEMENT;
    });
    if (count === 0) continue;
    filesTouched += 1;
    totalRedactions += count;
    console.log(`${WRITE ? "REDACTED" : "WOULD REDACT"}  ${count}  ${file}`);
    if (WRITE) {
      // flag "w" truncates the existing file: same inode, so a still-open
      // session appending to this file keeps working.
      writeFileSync(file, scrubbed, { flag: "w" });
    }
  }
}

console.log("");
if (totalRedactions === 0) {
  console.log("No private-key material found in any scanned location.");
} else {
  console.log(
    `${WRITE ? "Redacted" : "Found"} ${totalRedactions} occurrence(s) across ${filesTouched} file(s).` +
      (WRITE ? "" : "  Re-run with --write to redact.")
  );
  console.log("Reminder: this cannot un-transmit anything. Rotation is still the real fix.");
}
