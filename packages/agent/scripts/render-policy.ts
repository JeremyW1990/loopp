// CLI: regenerate the committed customer-facing policy document from
// POLICY_RULES. Run with `pnpm --filter @loopp/agent policy:render`.
//
// The output path is resolved from this script file via import.meta.url —
// never from process.cwd() — so the command writes the same file no matter
// which directory it is invoked from.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { POLICY_RULES } from "../src/rules";
import { renderPolicyMarkdown } from "../src/render";

const outUrl = new URL("../../../docs/refund-policy.md", import.meta.url);
writeFileSync(outUrl, renderPolicyMarkdown(POLICY_RULES), "utf8");
console.log(`Wrote ${fileURLToPath(outUrl)}`);
