import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendJsonlEntry,
  type JsonlStorageError,
  overwriteJsonlEntries,
  readJsonlEntries,
  withLockedJsonlFile,
} from "../storage/jsonl.ts";

const TEST_ROOT = join(tmpdir(), "pi-teams-jsonl-test-tmp");

describe("JSONL storage", () => {
  beforeEach(async () => {
    await mkdir(TEST_ROOT, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_ROOT, { recursive: true, force: true });
  });

  it("appends and reads JSONL entries", async () => {
    const filePath = join(TEST_ROOT, "events.jsonl");

    await appendJsonlEntry(filePath, { kind: "one", value: 1 });
    await appendJsonlEntry(filePath, { kind: "two", value: 2 });

    await expect(
      readJsonlEntries<{ kind: string; value: number }>(filePath),
    ).resolves.toEqual([
      { kind: "one", value: 1 },
      { kind: "two", value: 2 },
    ]);
  });

  it("serializes concurrent append-only writes safely", async () => {
    const filePath = join(TEST_ROOT, "mailbox.jsonl");

    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        appendJsonlEntry(filePath, { index, payload: `message-${index}` }),
      ),
    );

    const entries = await readJsonlEntries<{ index: number; payload: string }>(
      filePath,
    );

    expect(entries).toHaveLength(25);
    expect(new Set(entries.map((entry) => entry.index))).toEqual(
      new Set(Array.from({ length: 25 }, (_, index) => index)),
    );
  });

  it("overwrites JSONL entries through the standalone helper", async () => {
    const filePath = join(TEST_ROOT, "overwrite.jsonl");

    await appendJsonlEntry(filePath, { id: "first" });
    await overwriteJsonlEntries(filePath, [{ id: "replacement" }]);

    await expect(readJsonlEntries<{ id: string }>(filePath)).resolves.toEqual([
      { id: "replacement" },
    ]);
  });

  it("supports read-modify-write work under one lock scope", async () => {
    const filePath = join(TEST_ROOT, "cursor.jsonl");

    await withLockedJsonlFile<{ id: string }, void>(filePath, async (file) => {
      await file.appendEntry({ id: "first" });
      const entries = await file.readEntries();
      await file.overwriteEntries([...entries, { id: "second" }]);
    });

    await expect(readJsonlEntries<{ id: string }>(filePath)).resolves.toEqual([
      { id: "first" },
      { id: "second" },
    ]);
  });

  it("uses a read-specific error code when reading JSONL fails", async () => {
    const directoryPath = join(TEST_ROOT, "not-a-file");
    await mkdir(directoryPath, { recursive: true });

    await expect(readJsonlEntries(directoryPath)).rejects.toMatchObject({
      name: "JsonlStorageError",
      code: "jsonl-read-failed",
    } satisfies Pick<JsonlStorageError, "name" | "code">);
  });
});
