// ---------------------------------------------------------------------------
// Customer-facing policy document renderer.
//
// renderPolicyMarkdown() turns POLICY_RULES (or any injected rule set) into
// the markdown committed at docs/refund-policy.md. It is pure and
// deterministic: section order is array order, every numeric value in the
// prose is interpolated from rule params (so changing rules.ts changes the
// document), and the output ends with a single trailing LF. Regenerate the
// committed file with `pnpm --filter @loopp/agent policy:render` — never
// hand-edit it.
// ---------------------------------------------------------------------------

import { formatCents } from "@loopp/shared";
import { POLICY_RULES, type PolicyRule } from "./rules";

const BANNER =
  "<!-- AUTO-GENERATED from packages/agent/src/rules.ts — do not edit; regenerate with pnpm --filter @loopp/agent policy:render -->";

/**
 * Format a `{param}` value for prose. Money params (keys ending in "Cents")
 * render as dollars via formatCents ("$500.00"); everything else renders as
 * a plain number — the surrounding prose carries the unit, as in
 * "{windowDays} days".
 */
function formatParamValue(key: string, value: number): string {
  return key.endsWith("Cents") ? formatCents(value) : String(value);
}

/**
 * Replace every `{param}` placeholder in `text` with the formatted value of
 * the param of the same name. A placeholder with no matching param is a bug
 * in rules.ts, so it fails loudly instead of leaking braces into the doc.
 */
function interpolate(
  text: string,
  params: Readonly<Record<string, number>>,
): string {
  return text.replace(/\{(\w+)\}/g, (placeholder, key: string) => {
    const value = params[key];
    if (value === undefined) {
      throw new Error(
        `Placeholder ${placeholder} has no matching rule param to interpolate`,
      );
    }
    return formatParamValue(key, value);
  });
}

/**
 * Render the customer-facing refund policy as markdown. Pure and
 * deterministic: same rules in, same bytes out. Sections appear in array
 * order, one per rule, with all numbers interpolated from `rule.params` —
 * the renderer itself contains no policy literals.
 */
export function renderPolicyMarkdown(
  rules: readonly PolicyRule[] = POLICY_RULES,
): string {
  const lines: string[] = [
    BANNER,
    "",
    "# Loopp Refund Policy",
    "",
    "This policy explains when Loopp issues refunds. It is rendered directly from the rule data that drives our automated eligibility checks, so the rules below are exactly the rules the system enforces.",
  ];

  rules.forEach((rule, index) => {
    lines.push("", `## ${index + 1}. ${rule.title}`, "", interpolate(rule.summary, rule.params));
  });

  return lines.join("\n") + "\n";
}
