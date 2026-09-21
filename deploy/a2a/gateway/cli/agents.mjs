#!/usr/bin/env node
// 列出两个 agent 的 Agent Card（发现）
import { A2AClient, loadConfig } from "@a2a-bridge/shared";

const cfg = loadConfig();
for (const [name, a] of Object.entries(cfg.agents)) {
  try {
    const card = await new A2AClient(`http://127.0.0.1:${a.port}/`, cfg.apiKey || undefined).getCard();
    console.log(`=== ${name} (${card.name}) ${card.supportedInterfaces[0].url}`);
    console.log(card.description);
    for (const s of card.skills) console.log(`  - ${s.id}: ${s.description}`);
  } catch (e) {
    console.error(`=== ${name}: 不可用 (${e.message})`);
  }
}
