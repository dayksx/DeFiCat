import type { ClockPort } from "../../app/ports/clock/ClockPort.js";

export class SystemClockAdapter implements ClockPort {
  now(): Date {
    return new Date();
  }
}