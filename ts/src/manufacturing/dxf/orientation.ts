export type Vec3 = [number, number, number];

export interface PanelFrame {
  origin: Vec3;
  u: Vec3;
  v: Vec3;
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
  const mov = toOrthonormalFrame(moving, eps);

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
