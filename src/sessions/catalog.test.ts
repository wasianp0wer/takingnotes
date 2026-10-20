import { describe, expect, it } from "vitest";

import {
  buildSessionCatalog,
  entryStartedAt,
  findEntry,
} from "@/sessions/catalog";
import type { NoteRecord, RecordingRecord } from "@/storage/types";

function note(
  id: string,
  startedAt: number,
  sessionId?: string | null,
): NoteRecord {
  const n: NoteRecord = {
    id,
    title: `title ${id}`,
    status: "complete",
    deviceId: "d",
    deviceType: "huion",
    deviceName: null,
    startedAt,
    endedAt: null,
    pageBaseline: 0,
    pageWidth: null,
    pageHeight: null,
    summary: null,
    summaryModel: null,
    legacy: false,
    legacySourceId: null,
  };
  if (sessionId !== undefined) n.sessionId = sessionId;
  return n;
}

function rec(
  id: string,
  startedAt: number,
  link: { sessionId?: string | null; noteId?: string | null } = {},
): RecordingRecord {
  return {
    id,
    sessionId: link.sessionId ?? null,
    noteId: link.noteId ?? null,
    title: `rec ${id}`,
    startedAt,
    endedAt: null,
    durationMs: 1,
    mimeType: "audio/webm",
    byteLength: 1,
    transcript: null,
  };
}

describe("buildSessionCatalog", () => {
  it("puts a note with a sessionId in sessions and others in uncategorized", () => {
    const c = buildSessionCatalog(
      [note("a", 1, "s1"), note("b", 2, null), note("c", 3)],
      [],
    );
    expect(c.sessions.map((e) => e.key)).toEqual(["note:a"]);
    expect(c.uncategorized.map((e) => e.key)).toEqual(["note:c", "note:b"]);
  });

  it("attaches recordings directly and through the session, startedAt ascending", () => {
    const c = buildSessionCatalog(
      [note("a", 1, "s1")],
      [
        rec("r3", 30, { noteId: "a" }),
        rec("r1", 10, { sessionId: "s1" }),
        rec("r2", 20, { noteId: "a" }),
      ],
    );
    const entry = c.sessions[0];
    expect(entry.kind === "note" && entry.recordings.map((r) => r.id)).toEqual([
      "r1",
      "r2",
      "r3",
    ]);
    expect(c.uncategorized).toEqual([]);
  });

  it("a recording with no owning note is its own uncategorized entry", () => {
    const c = buildSessionCatalog(
      [note("a", 1, "s1")],
      [rec("r1", 5, { sessionId: "other" }), rec("r2", 6)],
    );
    expect(c.uncategorized.map((e) => e.key)).toEqual([
      "recording:r2",
      "recording:r1",
    ]);
    expect(c.sessions.map((e) => e.key)).toEqual(["note:a"]);
  });

  it("orders both lists newest first and interleaves uncategorized by date", () => {
    const c = buildSessionCatalog(
      [
        note("a", 10, "s1"),
        note("b", 30, "s2"),
        note("u", 20),
        note("v", 40, null),
      ],
      [rec("r", 25), rec("q", 5)],
    );
    expect(c.sessions.map((e) => e.key)).toEqual(["note:b", "note:a"]);
    expect(c.uncategorized.map((e) => e.key)).toEqual([
      "note:v",
      "recording:r",
      "note:u",
      "recording:q",
    ]);
    expect(entryStartedAt(c.uncategorized[1])).toBe(25);
  });
});

describe("findEntry", () => {
  it("finds entries in either list and returns null for missing or null keys", () => {
    const c = buildSessionCatalog([note("a", 1, "s1")], [rec("r", 2)]);
    expect(findEntry(c, "note:a")?.key).toBe("note:a");
    expect(findEntry(c, "recording:r")?.key).toBe("recording:r");
    expect(findEntry(c, "note:missing")).toBeNull();
    expect(findEntry(c, null)).toBeNull();
  });
});
