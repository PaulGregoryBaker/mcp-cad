import * as http from 'node:http';
import { geometryBinding } from '../geometry/binding';

const SHELL_GLB_ROUTE = /^\/mesh\/([^/]+)\.glb$/;

// ─── Minimal GLB synthesizer ──────────────────────────────────────────────────
// Used until the C++ addon implements exportGlb(shellId).
// Builds a valid GLB box sized from shell topology (flange dims or face area).

function pad4(buf: Buffer, fill = 0): Buffer {
  const rem = buf.length % 4;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - rem, fill)]);
}

function buildGlbBox(wM: number, hM: number, dM: number): Buffer {
  const hw = wM / 2, hh = hM / 2, hd = dM / 2;

  // 24 vertices (4 per face × 6 faces), per-face normals
  // prettier-ignore
  const pos = new Float32Array([
    -hw,-hh, hd,  hw,-hh, hd,  hw, hh, hd, -hw, hh, hd,  // +Z
     hw,-hh,-hd, -hw,-hh,-hd, -hw, hh,-hd,  hw, hh,-hd,  // -Z
    -hw, hh, hd,  hw, hh, hd,  hw, hh,-hd, -hw, hh,-hd,  // +Y
    -hw,-hh,-hd,  hw,-hh,-hd,  hw,-hh, hd, -hw,-hh, hd,  // -Y
     hw,-hh, hd,  hw,-hh,-hd,  hw, hh,-hd,  hw, hh, hd,  // +X
    -hw,-hh,-hd, -hw,-hh, hd, -hw, hh, hd, -hw, hh,-hd,  // -X
  ]);
  // prettier-ignore
  const nor = new Float32Array([
     0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,
     0, 0,-1,  0, 0,-1,  0, 0,-1,  0, 0,-1,
     0, 1, 0,  0, 1, 0,  0, 1, 0,  0, 1, 0,
     0,-1, 0,  0,-1, 0,  0,-1, 0,  0,-1, 0,
     1, 0, 0,  1, 0, 0,  1, 0, 0,  1, 0, 0,
    -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0,
  ]);

  const idxArr: number[] = [];
  for (let f = 0; f < 6; f++) {
    const b = f * 4;
    idxArr.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const idx = new Uint16Array(idxArr);

  const posB  = pad4(Buffer.from(pos.buffer));
  const norB  = pad4(Buffer.from(nor.buffer));
  const idxB  = pad4(Buffer.from(idx.buffer));
  const binData = Buffer.concat([posB, norB, idxB]);

  const json = JSON.stringify({
    asset: { version: '2.0', generator: 'mcp-cad-synthesizer' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, mode: 4 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3',
        min: [-hw, -hh, -hd], max: [hw, hh, hd] },
      { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0,                      byteLength: posB.length },
      { buffer: 0, byteOffset: posB.length,             byteLength: norB.length },
      { buffer: 0, byteOffset: posB.length + norB.length, byteLength: idxB.length },
    ],
    buffers: [{ byteLength: binData.length }],
  });

  const jsonB = pad4(Buffer.from(json, 'utf8'), 0x20); // pad with spaces
  const total = 12 + 8 + jsonB.length + 8 + binData.length;
  const glb   = Buffer.allocUnsafe(total);
  let off = 0;

  glb.writeUInt32LE(0x46546C67, off); off += 4; // magic 'glTF'
  glb.writeUInt32LE(2,          off); off += 4;
  glb.writeUInt32LE(total,      off); off += 4;

  glb.writeUInt32LE(jsonB.length,   off); off += 4;
  glb.writeUInt32LE(0x4E4F534A,     off); off += 4; // 'JSON'
  jsonB.copy(glb, off); off += jsonB.length;

  glb.writeUInt32LE(binData.length, off); off += 4;
  glb.writeUInt32LE(0x004E4942,     off); off += 4; // 'BIN\0'
  binData.copy(glb, off);

  return glb;
}

function synthesizeShellGlb(shellId: string): Buffer {
  // Fallback dimensions (300 × 300 × 15 mm) used if topology is unavailable.
  let wM = 0.3, hM = 0.3, dM = 0.015;

  try {
    const topo = geometryBinding.getTopology(shellId);

    if (topo.flanges && topo.flanges.length > 0) {
      // Use the largest flange footprint to drive the panel size.
      const best = topo.flanges.reduce((a, b) =>
        a.widthMm * a.lengthMm > b.widthMm * b.lengthMm ? a : b,
      );
      wM = best.widthMm / 1000;
      hM = best.lengthMm / 1000;
    } else if (topo.faces && topo.faces.length > 0) {
      // Estimate from total face area — assume two large opposing faces.
      const totalMm2 = topo.faces.reduce((s, f) => s + f.areaMm2, 0);
      const side = Math.sqrt(totalMm2 / 2);
      wM = side / 1000;
      hM = side / 1000;
    }

    // Use bend radii to infer thickness when available.
    if (topo.bends && topo.bends.length > 0) {
      const minRadius = Math.min(...topo.bends.map((b) => b.radiusMm));
      dM = Math.max(0.001, minRadius / 1000);
    }
  } catch {
    // Fall through with defaults.
  }

  return buildGlbBox(wM, hM, dM);
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

export function startMeshServer(port: number): http.Server {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }

    const match = req.url?.match(SHELL_GLB_ROUTE);
    if (!match) {
      res.writeHead(404);
      res.end();
      return;
    }

    const shellId = decodeURIComponent(match[1]!);
    try {
      let glbData: Buffer;
      try {
        // Use the C++ exporter when available; fall back to the TS synthesizer.
        glbData = geometryBinding.exportGlb(shellId);
      } catch {
        glbData = synthesizeShellGlb(shellId);
      }

      res.writeHead(200, {
        'Content-Type': 'model/gltf-binary',
        'Content-Length': glbData.length,
        'Cache-Control': 'no-store',
      });
      res.end(glbData);
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'shell_not_found', shell_id: shellId }));
    }
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[mesh-server] Port ${port} is already in use — mesh server will not start. ` +
        `Kill the previous process or set MESH_PORT to a free port.`,
      );
      // Do NOT crash: the MCP stdio transport still works without the mesh server.
    } else {
      console.error('[mesh-server] Unexpected error:', err);
    }
  });

  server.listen(port);
  return server;
}
