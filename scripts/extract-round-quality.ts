/**
 * Extract real round transcripts from personal-agent/.personal-agent/ sessions,
 * pair each user prompt with its assistant output, and emit them as JSONL ready
 * for Jev labeling.
 *
 * The label Jev provides is `round_success`: did the assistant actually
 * accomplish the user's request? D19's `evaluateRun` only sees tool-call counts
 * and `failureClass`, so a model that produced empty / off-topic output still
 * counts as `success`. Jev's noul probability can fill that gap.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface ChatMessage {
  readonly kind: "message";
  readonly at?: string;
  readonly message: { readonly role: "user" | "assistant" | "tool"; readonly content: string };
}

async function readMessages(path: string): Promise<ChatMessage[]> {
  const text = await readFile(path, "utf8");
  const out: ChatMessage[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const j = JSON.parse(line) as { kind?: string; message?: { role?: string; content?: string } };
      if (j.kind === "message" && j.message?.role && j.message?.content !== undefined) {
        out.push(j as unknown as ChatMessage);
      }
    } catch { /* skip malformed lines */ }
  }
  return out;
}

interface Round {
  readonly file: string;
  readonly userPrompt: string;
  readonly assistantOutput: string;
  readonly mechanical: "success" | "empty";
}

function classifyRound(asstContent: string): Round["mechanical"] {
  const t = (asstContent ?? "").trim();
  return t.length < 5 ? "empty" : "success";
}

async function main(): Promise<void> {
  const home = "D:/DSHXM/AgentKHD/personal-agent/.personal-agent";
  const files = (await readdir(home)).filter((n) =>
    n.endsWith(".jsonl") && (n.startsWith("chat-") || n.startsWith("desktop-chat-"))
  );
  const rounds: Round[] = [];
  for (const f of files) {
    const msgs = await readMessages(join(home, f));
    let lastUser: ChatMessage | null = null;
    const asstBlocks: string[] = [];
    for (const m of msgs) {
      if (m.message.role === "user") {
        if (lastUser) {
          const merged = asstBlocks.filter((s) => s.trim().length > 0).join("\n");
          rounds.push({
            file: f,
            userPrompt: lastUser.message.content,
            assistantOutput: merged,
            mechanical: classifyRound(merged),
          });
        }
        lastUser = m;
        asstBlocks.length = 0;
      } else if (m.message.role === "assistant" && lastUser) {
        asstBlocks.push(m.message.content ?? "");
      }
    }
    if (lastUser) {
      const merged = asstBlocks.filter((s) => s.trim().length > 0).join("\n");
      rounds.push({
        file: f,
        userPrompt: lastUser.message.content,
        assistantOutput: merged,
        mechanical: classifyRound(merged),
      });
    }
  }
  const seen = new Set<string>();
  const deduped = rounds.filter((r) => {
    const k = `${r.file}:${r.userPrompt.slice(0, 80)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const byMech = { success: 0, empty: 0 };
  for (const r of deduped) byMech[r.mechanical]++;
  console.log(`rounds: ${rounds.length} -> deduped: ${deduped.length}`);
  console.log("by mechanical:", JSON.stringify(byMech));
  const outPath = join(home, "round-transcripts.jsonl");
  await writeFile(outPath, deduped.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  console.log("wrote", outPath);
  for (const r of deduped.slice(0, 8)) {
    const p = r.userPrompt.slice(0, 40).replace(/\n/g, " ");
    const a = (r.assistantOutput ?? "").slice(0, 60).replace(/\n/g, " ");
    console.log(`  [${r.mechanical}] ${p}... -> ${a}...`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
