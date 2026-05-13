/**
 * LogisticsConstraints store.
 *
 * Task: T030
 */

export interface ShippingEnvelope {
  maxLengthMm: number;
  maxWidthMm: number;
  maxHeightMm: number;
}

export interface CoatingEnvelope {
  maxLengthMm: number;
  maxWidthMm: number;
}

export interface LogisticsConstraints {
  shippingEnvelope: ShippingEnvelope;
  maxWeightKg: number;
  coatingEnvelope: CoatingEnvelope;
}
