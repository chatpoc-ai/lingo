import { describe, expect, it } from "vitest";
import { textProblems } from "../src/checks.ts";

describe("textProblems: URLs", () => {
  it("does not take the punctuation after a URL for part of it", () => {
    for (const end of [",", ".", ";", ":", "!", "?"]) {
      expect(textProblems(`See http://example.com:8080/a${end} then go on`, "请看 http://example.com:8080/a 然后继续")).toEqual([]);
    }
  });

  it("ends a URL at the text of a language written without spaces", () => {
    const source = "the gateway (http://example.com:8080, purpose x) is slow";
    expect(textProblems(source, "网关（http://example.com:8080，用途 x）很慢")).toEqual([]);
    expect(textProblems(source, "网关 http://example.com:8080用途 x 很慢")).toEqual([]);
  });

  it("keeps the punctuation inside a URL", () => {
    const url = "https://example.com/a,b.c?d=x&e=y";
    expect(textProblems(`Open ${url} now`, `现在打开 ${url}`)).toEqual([]);
    expect(textProblems(`Open ${url} now`, "现在打开 https://example.com/a")).toEqual([`url ${url} is missing`]);
  });

  it("still finds a URL that was changed or lost", () => {
    expect(textProblems("See http://example.com:8080, then go on", "请看 http://example.com:9090，然后继续")).toEqual(["url http://example.com:8080 is missing", "number 8080 is missing"]);
    expect(textProblems("See http://example.com/a, then go on", "请看，然后继续")).toEqual(["url http://example.com/a is missing"]);
  });
});
