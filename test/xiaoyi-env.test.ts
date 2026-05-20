import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_XIAOYI_ENV_HEADER_MAP,
  normalizeXiaoyiEnvHeaderMap,
  parseXiaoyiEnvContent,
  readXiaoyiEnvConfig,
} from "../src/xiaoyi-env.js";

const tempDirs: string[] = [];

function tempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "llm-router-xiaoyi-env-"));
  tempDirs.push(dir);
  const file = join(dir, ".xiaoyienv");
  writeFileSync(file, content, "utf8");
  return file;
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("xiaoyi env", () => {
  it("parses KEY=value lines and ignores comments or malformed lines", () => {
    expect(
      parseXiaoyiEnvContent(`
# comment
SERVICE_URL=https://api.example.com
broken-line
 =empty-key
EMPTY_VALUE=
X-UID=123456
TOKEN=a=b=c
`),
    ).toEqual({
      SERVICE_URL: "https://api.example.com",
      "X-UID": "123456",
      TOKEN: "a=b=c",
    });
  });

  it("uses only mapped headers and keeps SERVICE_URL separate", () => {
    const path = tempFile(`
SERVICE_URL=https://gateway.example.com
X-UID=123456
SECRET=hidden
`);

    const result = readXiaoyiEnvConfig({ path });

    expect(result).toEqual({
      loaded: true,
      upstreamUrl: "https://gateway.example.com",
      headers: { "X-UID": "123456" },
    });
  });

  it("supports custom env-key to header-name mapping", () => {
    const path = tempFile("UID=123456\nTOKEN=abcdef\n");

    const result = readXiaoyiEnvConfig({
      path,
      headerMap: { UID: "X-UID", TOKEN: "X-Token" },
    });

    expect(result).toEqual({
      loaded: true,
      headers: { "X-UID": "123456", "X-Token": "abcdef" },
    });
  });

  it("returns loaded false when the env file is missing", () => {
    expect(
      readXiaoyiEnvConfig({ path: join(tmpdir(), "missing-xiaoyi-env") }),
    ).toEqual({
      loaded: false,
    });
  });

  it("normalizes invalid headerMap entries without throwing", () => {
    expect(DEFAULT_XIAOYI_ENV_HEADER_MAP).toEqual({ "X-UID": "X-UID" });
    expect(normalizeXiaoyiEnvHeaderMap({})).toEqual({});
    expect(
      normalizeXiaoyiEnvHeaderMap({
        EMPTY: "",
        BAD: 123,
      } as unknown as Record<string, unknown>),
    ).toEqual({});
    expect(
      normalizeXiaoyiEnvHeaderMap({
        UID: "X-UID",
        EMPTY: "",
        BAD: 123,
      } as unknown as Record<string, unknown>),
    ).toEqual({ UID: "X-UID" });
    expect(normalizeXiaoyiEnvHeaderMap(undefined)).toEqual(
      DEFAULT_XIAOYI_ENV_HEADER_MAP,
    );
    expect(normalizeXiaoyiEnvHeaderMap("bad")).toEqual(
      DEFAULT_XIAOYI_ENV_HEADER_MAP,
    );
  });

  it("preserves own __proto__ keys from parsed JSON headerMap objects", () => {
    const result = normalizeXiaoyiEnvHeaderMap(
      JSON.parse('{"__proto__":"X-Test","UID":"X-UID"}'),
    );

    expect(Object.keys(result)).toEqual(["__proto__", "UID"]);
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(result.__proto__).toBe("X-Test");
    expect(result.UID).toBe("X-UID");
  });

  it("allows callers to disable the default X-UID header mapping explicitly", () => {
    const withServiceUrlPath = tempFile(`
SERVICE_URL=https://gateway.example.com
X-UID=123456
`);
    const onlyUidPath = tempFile("X-UID=123456\n");

    expect(
      readXiaoyiEnvConfig({ path: withServiceUrlPath, headerMap: {} }),
    ).toEqual({
      loaded: true,
      upstreamUrl: "https://gateway.example.com",
    });
    expect(readXiaoyiEnvConfig({ path: onlyUidPath, headerMap: {} })).toEqual({
      loaded: false,
    });
  });

  it("never reads inherited prototype properties as header values", () => {
    const path = tempFile("SERVICE_URL=https://gateway.example.com\n");

    expect(
      readXiaoyiEnvConfig({
        path,
        headerMap: { toString: "X-Test", constructor: "X-Ctor" },
      }),
    ).toEqual({
      loaded: true,
      upstreamUrl: "https://gateway.example.com",
    });
  });

  it("reads __proto__ env keys through explicit header mappings as string headers", () => {
    const path = tempFile("__proto__=abc\n");

    expect(
      readXiaoyiEnvConfig({
        path,
        headerMap: JSON.parse('{"__proto__":"X-Test"}'),
      }),
    ).toEqual({
      loaded: true,
      headers: { "X-Test": "abc" },
    });
  });
});
