import { describe, it, expect } from "vitest";
import { csvField, csvRow, toCsv } from "./csv";

describe("csvField", () => {
  it("passes plain values through unquoted", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField(42)).toBe("42");
    expect(csvField(true)).toBe("true");
  });

  it("renders null/undefined as an empty field", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });

  it("quotes a field containing a comma", () => {
    expect(csvField("a,b")).toBe('"a,b"');
  });

  it("quotes and escapes a field containing a double quote", () => {
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes a field containing a newline", () => {
    expect(csvField("line1\nline2")).toBe('"line1\nline2"');
  });

  it("quotes a field containing a CRLF", () => {
    expect(csvField("line1\r\nline2")).toBe('"line1\r\nline2"');
  });

  it("JSON-stringifies object values", () => {
    expect(csvField({ a: 1 })).toBe('"{""a"":1}"');
  });
});

describe("csvRow", () => {
  it("joins fields with commas", () => {
    expect(csvRow(["a", "b", "c"])).toBe("a,b,c");
  });

  it("mixes quoted and unquoted fields correctly", () => {
    expect(csvRow(["a", "b,c", "d"])).toBe('a,"b,c",d');
  });
});

describe("toCsv", () => {
  it("always emits the header row, even for zero data rows", () => {
    const out = toCsv(["id", "name"], []);
    const bodyAfterBom = out.slice(1); // strip BOM for comparison
    expect(bodyAfterBom).toBe("id,name\r\n");
  });

  it("prefixes a UTF-8 BOM", () => {
    const out = toCsv(["id"], []);
    expect(out.charCodeAt(0)).toBe(0xfeff);
  });

  it("uses CRLF line endings throughout", () => {
    const out = toCsv(["id", "name"], [
      [1, "alpha"],
      [2, "beta"],
    ]);
    const bodyAfterBom = out.slice(1);
    expect(bodyAfterBom).toBe("id,name\r\n1,alpha\r\n2,beta\r\n");
  });

  it("quotes fields containing commas, quotes, and newlines together", () => {
    const out = toCsv(["note"], [['has, comma and "quote" and\nnewline']]);
    const bodyAfterBom = out.slice(1);
    expect(bodyAfterBom).toBe(
      '"note"'.replace('"note"', "note") +
        "\r\n" +
        '"has, comma and ""quote"" and\nnewline"' +
        "\r\n",
    );
  });

  it("renders empty string for empty-string cells (not quoted)", () => {
    const out = toCsv(["a", "b"], [["", "value"]]);
    const bodyAfterBom = out.slice(1);
    expect(bodyAfterBom).toBe("a,b\r\n,value\r\n");
  });
});

describe("formula-injection neutralization (CWE-1236)", () => {
  it("prefixes leading = + @ and tab/CR with a quote", () => {
    expect(csvField('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csvField("+cmd")).toBe("'+cmd");
    expect(csvField("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvField("\t=1+1")).toContain("'\t=1+1");
  });

  it("prefixes leading minus on STRINGS but leaves negative NUMBERS numeric", () => {
    expect(csvField("-2+3+cmd")).toBe("'-2+3+cmd");
    expect(csvField(-42)).toBe("-42");
    expect(csvField(-4.5)).toBe("-4.5");
  });

  it("leaves ordinary text and numbers untouched", () => {
    expect(csvField("plain text")).toBe("plain text");
    expect(csvField(100)).toBe("100");
    expect(csvField(true)).toBe("true");
  });
});
