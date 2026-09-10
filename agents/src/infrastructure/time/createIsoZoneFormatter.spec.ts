import { describe, expect, it } from "vitest";
import { createIsoZoneFormatter } from "./createIsoZoneFormatter.js";

describe("createIsoZoneFormatter", () => {
  it("shifts an instant to the target zone during daylight saving time", () => {
    const format = createIsoZoneFormatter("Europe/Paris");

    expect(format("2026-06-13T01:52:19.000Z")).toBe("2026-06-13T03:52:19+02:00");
    expect(format("2026-09-11T01:52:19.000Z")).toBe("2026-09-11T03:52:19+02:00");
  });

  it("uses the winter offset for the same zone", () => {
    const format = createIsoZoneFormatter("Europe/Paris");

    expect(format("2026-01-26T01:52:19.000Z")).toBe("2026-01-26T02:52:19+01:00");
  });

  it("handles negative offsets and a date rollback", () => {
    const format = createIsoZoneFormatter("America/New_York");

    expect(format("2026-06-13T01:52:19.000Z")).toBe("2026-06-12T21:52:19-04:00");
  });

  it("keeps Z for UTC and for offsets that are not whole hours", () => {
    expect(createIsoZoneFormatter("UTC")("2026-06-13T01:52:19.000Z")).toBe(
      "2026-06-13T01:52:19Z",
    );
    expect(createIsoZoneFormatter("Asia/Kolkata")("2026-06-13T01:52:19.000Z")).toBe(
      "2026-06-13T07:22:19+05:30",
    );
  });

  it("passes through a value it cannot parse", () => {
    expect(createIsoZoneFormatter("Europe/Paris")("not-a-date")).toBe(
      "not-a-date",
    );
  });

  it("rejects an unknown time zone eagerly", () => {
    expect(() => createIsoZoneFormatter("Europe/Nowhere")).toThrow(RangeError);
  });
});
