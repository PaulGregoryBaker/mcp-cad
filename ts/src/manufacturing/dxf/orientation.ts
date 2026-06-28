export type Vec3 = [number, number, number];

export interface PanelFrame {
  origin: Vec3;
  u: Vec3;
  v: Vec3;
  // Panel's own extent along v (mm). Needed to correct origin when the
  // moving panel's normal must be flipped to avoid a mirrored 2D placement
  // (see the anti-parallel-normal branch in computeDxfMergePlacement below).
  // Optional for backward compatibility with callers that don't track it
  // (e.g. merge_bodies_with_bend's DXF-aligned frames); those callers simply
  // don't get the origin correction.
  vExtentMm?: number;
  // The panel's TRUE outward normal, as originally reported by getPanelFrame.
  // NOT always recoverable as cross(u, v): getPanelFrame swaps U/V to keep U
  // the longer in-plane axis, and that swap can flip the sign of u×v relative
  // to the face's actual normal (u×v = -normal exactly when the swap happened).
  // Any caller needing "this panel's normal" — e.g. to express a stored
  // midplaneOffsetMm (which was measured against THIS normal) in a placement
  // transform — must use this stored field, not recompute via cross(u, v).
  normal?: Vec3;
}

export interface OrientationOptions {
  // Maximum allowed absolute normal offset to still treat inputs as coplanar-contact.
  contactToleranceMm: number;
  // Numeric tolerance for orthonormal checks.
  epsilon?: number;
}

export interface MergePlacement2D {
  // 2D rigid transform placing moving DXF into reference panel DXF coordinates.
  // [x'; y'] = R * [x; y] + t
  rotationMatrix: [[number, number], [number, number]];
  translation: [number, number];
  rotationRadians: number;

  // Separation measured along reference normal.
  normalOffsetMm: number;
  inContact: boolean;
}

const DEFAULT_EPSILON = 1e-6;

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function norm(v: Vec3): number {
  return Math.sqrt(dot(v, v));
}

function normalize(v: Vec3): Vec3 {
  const n = norm(v);
  if (n <= 0) throw new Error('Invalid frame axis: zero length');
  return [v[0] / n, v[1] / n, v[2] / n];
}

function approxEqual(a: number, b: number, eps: number): boolean {
  return Math.abs(a - b) <= eps;
}

interface OrthonormalFrame {
  origin: Vec3;
  u: Vec3;
  v: Vec3;
  n: Vec3;
}

function toOrthonormalFrame(frame: PanelFrame, epsilon: number): OrthonormalFrame {
  const u = normalize(frame.u);
  const v = normalize(frame.v);

  if (!approxEqual(dot(u, v), 0, epsilon)) {
    throw new Error('Invalid panel frame: u and v must be orthogonal');
  }

  const n = normalize(cross(u, v));

  // Right-handed check: u x v should align with n by definition.
  const handedness = dot(cross(u, v), n);
  if (handedness < 1 - epsilon) {
    throw new Error('Invalid panel frame: basis must be right-handed');
  }

  return {
    origin: frame.origin,
    u,
    v,
    n,
  };
}

export function computeDxfMergePlacement(
  reference: PanelFrame,
  moving: PanelFrame,
  options: OrientationOptions,
): MergePlacement2D {
  const eps = options.epsilon ?? DEFAULT_EPSILON;
  if (options.contactToleranceMm < 0) {
    throw new Error('contactToleranceMm must be non-negative');
  }

  const ref = toOrthonormalFrame(reference, eps);
  let mov = toOrthonormalFrame(moving, eps);

  // getPanelFrame picks a panel's largest planar face to build its frame from.
  // A thin, symmetric panel (e.g. a flat flange tab) has two equal-area faces
  // with opposite outward normals, so which one gets picked — and therefore
  // which way the panel's reported normal points — is an arbitrary tie-break,
  // not a meaningful choice. When that leaves the moving panel's normal
  // anti-parallel to the reference's (rather than parallel, as two genuinely
  // coplanar panels should be), u/v/n no longer form a frame consistent with
  // the reference's own outward direction: the rotation matrix below comes
  // out as a REFLECTION (determinant -1) instead of a rotation (+1), mirroring
  // the moving panel's outline when it's merged into the reference's 2D space.
  // Flipping v (and so n) re-expresses the moving panel from its OTHER,
  // equal-area face — physically the same panel, just consistent with the
  // reference's side of the contact — restoring a proper rotation.
  //
  // origin is the panel's (u1,v1) MINIMUM corner under the ORIGINAL v
  // direction (see getPanelFrame). Flipping v's sign without relocating
  // origin would leave it sitting at the MAXIMUM corner under the new v —
  // offsetting the whole panel by its own height (vExtentMm) along the
  // flipped axis. Shifting origin to origin + vExtentMm*v (the old MAXIMUM
  // corner, which becomes the new MINIMUM corner once v is negated) keeps
  // the moving panel's outline anchored at the same physical location.
  if (dot(mov.n, ref.n) < 0) {
    const vExt = moving.vExtentMm ?? 0;
    const flippedOrigin: Vec3 = [
      mov.origin[0] + vExt * mov.v[0],
      mov.origin[1] + vExt * mov.v[1],
      mov.origin[2] + vExt * mov.v[2],
    ];
    mov = { origin: flippedOrigin, u: mov.u, v: [-mov.v[0], -mov.v[1], -mov.v[2]], n: [-mov.n[0], -mov.n[1], -mov.n[2]] };
  }

  // Moving basis expressed in reference panel coordinates.
  const ux = dot(mov.u, ref.u);
  const uy = dot(mov.u, ref.v);
  const vx = dot(mov.v, ref.u);
  const vy = dot(mov.v, ref.v);

  // In coplanar cases this is a 2D rotation matrix.
  const rotationMatrix: [[number, number], [number, number]] = [
    [ux, vx],
    [uy, vy],
  ];

  // Rotation angle from moving local +x (u) to reference local +x.
  const rotationRadians = Math.atan2(uy, ux);

  const delta = sub(mov.origin, ref.origin);
  const tx = dot(delta, ref.u);
  const ty = dot(delta, ref.v);
  const normalOffsetMm = dot(delta, ref.n);

  return {
    rotationMatrix,
    translation: [tx, ty],
    rotationRadians,
    normalOffsetMm,
    inContact: Math.abs(normalOffsetMm) <= options.contactToleranceMm,
  };
}
