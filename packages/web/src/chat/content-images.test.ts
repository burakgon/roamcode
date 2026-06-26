import { describe, expect, it } from "vitest";
import { imageBlockSrc, extractFilePaths } from "./content-images";

describe("imageBlockSrc", () => {
  it("builds a data url from a base64 image block", () => {
    expect(imageBlockSrc({ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } })).toBe(
      "data:image/png;base64,QUJD",
    );
  });
});

describe("extractFilePaths", () => {
  it("finds absolute file paths in text", () => {
    const paths = extractFilePaths("File created successfully at: /private/tmp/rc-spike/spike.txt now");
    expect(paths).toContain("/private/tmp/rc-spike/spike.txt");
  });
  it("dedupes and ignores non-paths", () => {
    expect(extractFilePaths("no paths here")).toEqual([]);
    const dup = extractFilePaths("/a/b.txt and again /a/b.txt");
    expect(dup).toEqual(["/a/b.txt"]);
  });
  it("does NOT turn URLs / domains into file-download chips", () => {
    // A link like https://code.claude.com used to match the path regex as `//code.claude.com`.
    expect(extractFilePaths("Sources:\n- Docs — https://code.claude.com\n- https://claudelog.com/x")).toEqual([]);
    expect(extractFilePaths("see http://example.com/page.html")).toEqual([]);
    // A real file path mentioned alongside a URL is still picked up.
    expect(extractFilePaths("edited /src/app.ts — see https://code.claude.com")).toEqual(["/src/app.ts"]);
  });
});
