#!/usr/bin/env node
// Enforces constitution v2.0.0 principle I's C++ half: only src/geometry/** may
// include OCCT headers directly. src/napi/** (the NAPI/TS-facing boundary) and
// src/acl/** must go through geometry/*.hpp's own interface — never reach past it
// into the kernel. Both currently do this correctly; this script exists to catch a
// regression, not to fix an existing violation (there isn't one today).
//
// Precise by construction, not by guessing OCCT naming conventions: builds the real
// set of OCCT header filenames from the actual vcpkg install, then flags any
// #include in a restricted directory that names one of those files.
//
// Usage: node cpp/tools/check-include-boundaries.mjs

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const CPP_ROOT = fileURLToPath(new URL('..', import.meta.url));

const OCCT_INCLUDE_DIRS = [
  join(CPP_ROOT, 'build-vcpkg', 'vcpkg_installed', 'x64-windows', 'include', 'opencascade'),
  join(CPP_ROOT, 'build', 'vcpkg_installed', 'x64-windows', 'include', 'opencascade'),
];

// Directories permitted to include OCCT headers directly — the GeometryKernel
// adapter. Everything else in src/ must go through its own .hpp interface.
const ALLOWED_DIR = join(CPP_ROOT, 'src', 'geometry');

// Directories this check actually scans (kept explicit rather than "everything
// except geometry/" so a newly-added directory doesn't silently join the allowlist).
const RESTRICTED_DIRS = [join(CPP_ROOT, 'src', 'napi'), join(CPP_ROOT, 'src', 'acl')];

function buildOcctHeaderSet() {
  for (const dir of OCCT_INCLUDE_DIRS) {
    try {
      const entries = readdirSync(dir);
      if (entries.length > 0) {
        return new Set(entries);
      }
    } catch {
      // try the next candidate install location
    }
  }
  throw new Error(
    'Could not find an OCCT include directory under build-vcpkg/ or build/ — ' +
      'run the vcpkg install first, or update OCCT_INCLUDE_DIRS in this script.'
  );
}

function listSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(cc|cpp|h|hpp)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const INCLUDE_RE = /^\s*#include\s*[<"]([^">]+)[">]/;

function main() {
  const occtHeaders = buildOcctHeaderSet();
  const violations = [];

  for (const dir of RESTRICTED_DIRS) {
    let files;
    try {
      files = listSourceFiles(dir);
    } catch {
      continue; // directory doesn't exist (yet) — nothing to check
    }
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        const match = INCLUDE_RE.exec(line);
        if (!match) return;
        const headerPath = match[1];
        const headerName = headerPath.split('/').pop();
        if (occtHeaders.has(headerName)) {
          violations.push({
            file: relative(CPP_ROOT, file),
            line: idx + 1,
            header: headerPath,
          });
        }
      });
    }
  }

  if (violations.length > 0) {
    console.error(
      `Found ${violations.length} direct OCCT include(s) outside src/geometry/ — ` +
        'constitution v2.0.0 principle I (only the GeometryKernel adapter may touch ' +
        'the kernel):\n'
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  #include "${v.header}"`);
    }
    console.error(
      `\nRoute through ${relative(CPP_ROOT, ALLOWED_DIR)}/*.hpp's own interface instead.`
    );
    process.exit(1);
  }

  console.log('OK: no restricted-directory file includes OCCT headers directly.');
}

main();
