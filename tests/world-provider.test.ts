import { describe, expect, it } from "vitest";
import type { BookingOperation } from "../src/lab/contract.js";
import { WorldProvider } from "../src/lab/world-provider.js";

const capabilities = { idempotent: true, query: true, amend: true };
const create = { kind: "create", key: "create-1", day: "Tuesday" } as const;
const query = { kind: "query", key: create.key } as const;
const amend = { kind: "amend", key: "amend-1", bookingId: "booking-1", day: "Thursday" } as const;

describe("world booking provider", () => {
  it("looks up current state by the original create key and reissues historical receipts to the new attempt", () => {
    const provider = new WorldProvider(capabilities);
    expect(provider.execute("lookup-0", query).reply).toMatchObject({ outcome: "missing", bookingId: null, day: null });
    expect(provider.execute("attempt-1", create).effect).toBe("created");
    expect(provider.execute("attempt-2", amend).effect).toBe("amended");
    expect(provider.execute("lookup-1", query)).toMatchObject({
      effect: "queried", reply: { outcome: "found", bookingId: "booking-1", day: "Thursday" },
    });
    expect(provider.execute("attempt-3", create)).toEqual({
      effect: "reused",
      reply: { kind: "provider-reply", requestId: "attempt-3", operation: create, outcome: "committed", bookingId: "booking-1", day: "Tuesday" },
    });
    expect(provider.execute("attempt-4", { ...amend, key: "amend-2", day: "Tuesday" }).effect).toBe("amended");
    expect(provider.execute("attempt-5", amend)).toMatchObject({
      effect: "reused", reply: { requestId: "attempt-5", bookingId: "booking-1", day: "Thursday" },
    });
    expect(provider.execute("lookup-2", query).reply.day).toBe("Tuesday");
    expect(provider.execute("lookup-3", { ...query, key: amend.key }).reply.outcome).toBe("missing");
  });

  it("rejects a reused key with a different day, operation kind, or amendment target", () => {
    const provider = new WorldProvider(capabilities);
    provider.execute("create-1", create);
    provider.execute("create-2", { ...create, key: "another-create" });
    provider.execute("amend-1", amend);
    const conflicts: BookingOperation[] = [
      { ...create, day: "Thursday" },
      { ...amend, key: create.key },
      { ...amend, bookingId: "booking-2" },
    ];
    for (const operation of conflicts) {
      expect(provider.execute("conflict", operation)).toMatchObject({
        effect: "rejected", reply: { outcome: "rejected", bookingId: null, day: null, reason: expect.stringMatching(/conflict/i) },
      });
    }
    expect(provider.activeBookings()).toEqual([
      { bookingId: "booking-1", createKey: create.key, day: "Thursday" },
      { bookingId: "booking-2", createKey: "another-create", day: "Tuesday" },
    ]);
  });

  it("fails before commitment without allocating an ID, changing a booking or consuming the key", () => {
    const provider = new WorldProvider(capabilities);
    expect(provider.execute("bad-create", create, true).reply.outcome).toBe("rejected");
    expect(provider.execute("lookup", query).reply.outcome).toBe("missing");
    expect(provider.execute("create-retry", create)).toMatchObject({ effect: "created", reply: { bookingId: "booking-1" } });
    expect(provider.execute("bad-amend", amend, true).reply.outcome).toBe("rejected");
    expect(provider.execute("lookup", query).reply.day).toBe("Tuesday");
    expect(provider.execute("amend-retry", amend).effect).toBe("amended");
    expect(provider.execute("no-target", { ...amend, key: "other-amend", bookingId: "absent" }).reply.outcome).toBe("rejected");
    expect(provider.execute("valid-target", { ...amend, key: "other-amend" }).effect).toBe("amended");
  });

  it("creates distinct reservations after a retry on an opaque provider and rejects unsupported operations", () => {
    const provider = new WorldProvider({ idempotent: false, query: false, amend: false });
    expect(provider.execute("attempt-1", create).reply.bookingId).toBe("booking-1");
    expect(provider.execute("attempt-2", create).reply.bookingId).toBe("booking-2");
    for (const operation of [amend, query]) {
      expect(provider.execute("unsupported", operation)).toMatchObject({
        effect: "rejected", reply: { outcome: "rejected", reason: expect.stringMatching(/support/i) },
      });
    }
    expect(provider.activeBookings().map(booking => booking.day)).toEqual(["Tuesday", "Tuesday"]);
  });

  it("reports an ambiguous lookup when a provider supports queries without idempotency", () => {
    const provider = new WorldProvider({ ...capabilities, idempotent: false });
    provider.execute("attempt-1", create);
    provider.execute("attempt-2", create);
    expect(provider.execute("lookup", query)).toMatchObject({
      effect: "rejected", reply: { outcome: "rejected", bookingId: null, day: null, reason: expect.stringMatching(/multiple/i) },
    });
  });

  it("isolates request, reply and diagnostic snapshots from live reservations and receipts", () => {
    const suppliedCapabilities = { ...capabilities };
    const provider = new WorldProvider(suppliedCapabilities);
    suppliedCapabilities.query = false;
    const supplied: BookingOperation = { ...create };
    const { reply } = provider.execute("first", supplied);
    supplied.day = "Thursday";
    reply.operation.key = "unrelated";
    reply.day = "Thursday";
    provider.activeBookings()[0]!.day = "Thursday";
    expect(provider.execute("retry", create)).toMatchObject({ effect: "reused", reply: { day: "Tuesday", operation: create } });
    expect(provider.execute("lookup", query).reply).toMatchObject({ outcome: "found", day: "Tuesday" });
  });
});
