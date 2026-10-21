import type { Direction } from "./simEngine";

export type ViolationType = "RED_LIGHT";
export type PaymentStatus = "Pending";

export interface EChallan {
  challanNumber: string;
  violationId: string;
  simulationTimestamp: number;
  lane: Direction;
  intersectionId: string;
  vehicleId: string;
  registrationNumber: string;
  violationType: ViolationType;
  description: string;
  fineAmount: number;
  paymentStatus: PaymentStatus;
}

export const FINE_AMOUNTS: Record<ViolationType, number> = {
  RED_LIGHT: 1000,
};

export function createEChallan(
  violation: Omit<EChallan, "challanNumber" | "fineAmount" | "paymentStatus">,
  sequence: number,
  year = new Date().getFullYear()
): EChallan {
  return {
    ...violation,
    challanNumber: `TC-${year}-${String(sequence).padStart(4, "0")}`,
    fineAmount: FINE_AMOUNTS[violation.violationType],
    paymentStatus: "Pending",
  };
}
