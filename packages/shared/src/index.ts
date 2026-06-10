// Use the global Web Crypto `randomUUID` (stable in Node >=20 and every
// browser) rather than `node:crypto`, so this leaf utility stays isomorphic:
// the web bundle imports `formatCents` from here and must not pull in a Node
// builtin (which Rollup cannot externalize for the browser).
export type IdPrefix = "conv" | "msg" | "run" | "ref" | "pay";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}
