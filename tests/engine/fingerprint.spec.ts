// fingerprint-v1（§8.2）：成对相等/不等 + canonical 精确哈希冻结。
// canonical 用内联快照：首次运行写入，此后任何序列化规则变化都会击穿——
// 变更规则必须升级 fingerprint-v1 → parser_version 并连带更新本快照。

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeDocument } from "../../src/engine/analyze";
import { buildDefinitionMap, fingerprintBody } from "../../src/engine/fingerprint";
import { parseMarkdown, segmentDocument } from "../../src/engine/segment";
import { FIXTURE_ROOT, readFixture, readJson } from "../fixtures/load";

const root = join(FIXTURE_ROOT, "fingerprint");

async function firstBodyHash(rel: string): Promise<string> {
  const text = readFixture(rel);
  const rep = await analyzeDocument({ relativePath: "doc.md", text, rawByteHash: "" });
  expect(rep.blocks).toHaveLength(1);
  return rep.blocks[0].bodyHash;
}

describe("fingerprint-v1 成对比较", () => {
  const pairs = readdirSync(root).filter((d) => !d.endsWith(".ts") && d !== "canonical");
  for (const p of pairs) {
    const exp = readJson<{ equal: boolean }>(`fingerprint/${p}/expect.json`);
    it(`${p}：bodyHash ${exp.equal ? "相等" : "不等"}`, async () => {
      const [a, b] = await Promise.all([
        firstBodyHash(`fingerprint/${p}/a.md`),
        firstBodyHash(`fingerprint/${p}/b.md`),
      ]);
      if (exp.equal) expect(a).toBe(b);
      else expect(a).not.toBe(b);
    });
  }
});

describe("fingerprint-v1 canonical 冻结", () => {
  it("canonical input 的序列化串与 bodyHash", async () => {
    const text = readFixture("fingerprint/canonical/input.md");
    const ast = parseMarkdown(text);
    const candidates = segmentDocument(text, ast);
    expect(candidates).toHaveLength(1);
    const serialized = fingerprintBody(candidates[0].bodyChildren, buildDefinitionMap(ast));
    expect(JSON.stringify(serialized)).toMatchInlineSnapshot(`""paragraph[text(v=\\"正文与 \\"),emphasis[text(v=\\"强调\\")],text(v=\\"、\\"),strong[text(v=\\"加粗\\")],text(v=\\"、\\"),inlineCode(v=\\"行内码\\"),text(v=\\"、\\"),link(url=\\"https://a.example\\",title=\\"标题属性\\")[text(v=\\"链接\\")],text(v=\\"、\\"),image(url=\\"img.png\\",title=\\"图题\\",alt=\\"图片\\"),text(v=\\"。\\")]\\u0000list(ordered=0,start=null,spread=0)[listItem(checked=null)[paragraph[text(v=\\"列表甲\\")]],listItem(checked=false)[paragraph[text(v=\\"任务项\\")]]]\\u0000blockquote[paragraph[text(v=\\"引用段\\")]]\\u0000code(lang=\\"rust\\",meta=null,v=\\"fn main() {\\\\n    println!(\\\\\\"代码空白 保留\\\\\\");\\\\n}\\")\\u0000table(align=nn)[tableRow[tableCell[text(v=\\"左\\")],tableCell[text(v=\\"右\\")]],tableRow[tableCell[text(v=\\"一\\")],tableCell[text(v=\\"二\\")]]]\\u0000paragraph[text(v=\\"结尾见\\"),link(url=\\"https://ref.example\\",title=\\"引用题\\")[text(v=\\"引用式\\")],text(v=\\"。\\")]""`);
    const rep = await analyzeDocument({ relativePath: "doc.md", text, rawByteHash: "" });
    expect(rep.blocks[0].bodyHash).toMatchInlineSnapshot(`"fe2ba8ac708e765352be618aa80684360649622bc8bb48de248b62db350ad49c"`);
  });
});
