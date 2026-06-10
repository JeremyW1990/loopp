// ---------------------------------------------------------------------------
// Renderer tests: the committed policy document is provably in sync with
// POLICY_RULES, and the rendered prose is provably derived from rule params.
//
// The committed artifact is resolved relative to THIS file (import.meta.url),
// never process.cwd(), so the suite passes regardless of where vitest runs.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderPolicyMarkdown } from "./render";
import { POLICY_RULES, type PolicyRule, type PolicyRuleId } from "./rules";

/** The committed generated artifact at the repo root. */
const COMMITTED_DOC_URL = new URL(
  "../../../docs/refund-policy.md",
  import.meta.url,
);

/** POLICY_RULES with windowDays / thresholdCents overridden. */
function ruleSet(overrides: {
  windowDays?: number;
  thresholdCents?: number;
}): PolicyRule[] {
  return POLICY_RULES.map((rule): PolicyRule => {
    if (rule.id === "return_window" && overrides.windowDays !== undefined) {
      return { ...rule, params: { windowDays: overrides.windowDays } };
    }
    if (
      rule.id === "escalation_threshold" &&
      overrides.thresholdCents !== undefined
    ) {
      return { ...rule, params: { thresholdCents: overrides.thresholdCents } };
    }
    return rule;
  });
}

function withoutRule(id: PolicyRuleId): PolicyRule[] {
  return POLICY_RULES.filter((rule) => rule.id !== id);
}

describe("renderPolicyMarkdown", () => {
  it("committed docs/refund-policy.md is byte-identical to a fresh render", () => {
    // If this fails, someone hand-edited the doc or changed rules.ts without
    // regenerating: run `pnpm --filter @loopp/agent policy:render`.
    const committed = readFileSync(COMMITTED_DOC_URL, "utf8");
    expect(renderPolicyMarkdown(POLICY_RULES)).toBe(committed);
  });

  it("doc opens with the AUTO-GENERATED do-not-edit banner", () => {
    const [firstLine] = renderPolicyMarkdown(POLICY_RULES).split("\n");
    expect(firstLine).toContain("AUTO-GENERATED from packages/agent/src/rules.ts");
    expect(firstLine).toContain("do not edit");
    expect(firstLine).toContain("pnpm --filter @loopp/agent policy:render");
  });

  it("render is deterministic and ends with exactly one trailing newline", () => {
    const first = renderPolicyMarkdown(POLICY_RULES);
    expect(renderPolicyMarkdown(POLICY_RULES)).toBe(first);
    expect(first.endsWith("\n")).toBe(true);
    expect(first.endsWith("\n\n")).toBe(false);
  });

  it("rendering with default rules equals rendering with explicit POLICY_RULES", () => {
    expect(renderPolicyMarkdown()).toBe(renderPolicyMarkdown(POLICY_RULES));
  });

  it("renders one section per rule, titled from the rule data", () => {
    const doc = renderPolicyMarkdown(POLICY_RULES);
    for (const rule of POLICY_RULES) {
      // Section numbers come from array order, so match on the title text.
      expect(doc).toContain(`. ${rule.title}`);
    }
    expect(doc.match(/^## /gm)).toHaveLength(POLICY_RULES.length);
  });

  it("changing windowDays and thresholdCents in the rule data changes the rendered text", () => {
    const defaults = renderPolicyMarkdown(POLICY_RULES);
    expect(defaults).toContain("30 days");
    expect(defaults).toContain("$500.00");

    const modified = renderPolicyMarkdown(
      ruleSet({ windowDays: 14, thresholdCents: 10000 }),
    );
    expect(modified).toContain("14 days");
    expect(modified).toContain("$100.00");
    expect(modified).not.toContain("30 days");
    expect(modified).not.toContain("$500.00");
  });

  it("policy doc states refunds go to the original payment method", () => {
    const doc = renderPolicyMarkdown(POLICY_RULES);
    expect(doc).toContain("Original payment method");
    expect(doc).toContain("never to a different card, account, or store credit");
  });

  it("filtering out original_payment_method removes its wording from the doc", () => {
    const doc = renderPolicyMarkdown(withoutRule("original_payment_method"));
    expect(doc.toLowerCase()).not.toContain("original payment method");
    expect(doc).not.toContain("never to a different card");
  });

  it("policy doc states refunds are assessed per item", () => {
    const doc = renderPolicyMarkdown(POLICY_RULES);
    expect(doc).toContain("Partial refunds");
    expect(doc).toContain("assessed per item");
  });

  it("filtering out partial_refunds removes its wording from the doc", () => {
    const doc = renderPolicyMarkdown(withoutRule("partial_refunds"));
    expect(doc.toLowerCase()).not.toContain("partial refunds");
    expect(doc).not.toContain("assessed per item");
  });
});
