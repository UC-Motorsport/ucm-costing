import Decimal from "decimal.js";
import { z } from "zod";

export const positiveDecimalStringSchema = z
  .union([z.string(), z.number()])
  .transform((value) => String(value).trim())
  .refine((value) => {
    try {
      const decimal = new Decimal(value);
      return decimal.isFinite() && decimal.greaterThan(0);
    } catch {
      return false;
    }
  }, "Quantity must be a finite decimal greater than zero");

export const fractionSchema = z
  .union([z.string(), z.number()])
  .transform((value) => String(value).trim())
  .refine((value) => {
    try {
      const fraction = new Decimal(value);
      return (
        fraction.isFinite() &&
        fraction.greaterThan(0) &&
        fraction.lessThanOrEqualTo(1)
      );
    } catch {
      return false;
    }
  }, "Fraction included must be greater than zero and at most one");
