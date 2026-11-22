// Shared machinery for arranging preset fields into OrcaSlicer-style tabs and
// sub-sections. Each preset type (machine, filament, …) supplies its own
// ordered keyword rules and tab/section ordering; the grouping, ordering, and
// "Other" fallback live here so every type behaves identically.

import type { EditorField, EditorTab } from "./orcaSchema";

export type LayoutRule = { tab: string; section: string; test: RegExp };

export type LayoutSpec = {
  rules: readonly LayoutRule[];
  /** Tab render order; tabs not listed are appended (with "Other" always last-ish). */
  tabOrder: readonly string[];
  /** Per-tab sub-section render order. */
  sectionOrder: Record<string, readonly string[]>;
};

/** Classify a key against a spec's rules, or fall back to the "Other" tab. */
export function classifyKey(key: string, rules: readonly LayoutRule[]): { tab: string; section: string } {
  for (const rule of rules) {
    if (rule.test.test(key)) return { tab: rule.tab, section: rule.section };
  }
  return { tab: "Other", section: "" };
}

function rank(order: readonly string[], value: string): number {
  const index = order.indexOf(value);
  return index === -1 ? order.length : index;
}

/** Arrange already-derived editable fields into a spec's tab/section tree. */
export function arrangeTabs(fields: EditorField[], spec: LayoutSpec): EditorTab[] {
  const tabs = new Map<string, Map<string, EditorField[]>>();

  for (const field of fields) {
    const { tab, section } = classifyKey(field.key, spec.rules);
    let sections = tabs.get(tab);
    if (!sections) {
      sections = new Map();
      tabs.set(tab, sections);
    }
    const bucket = sections.get(section);
    if (bucket) bucket.push(field);
    else sections.set(section, [field]);
  }

  const knownTabs = spec.tabOrder.filter((title) => tabs.has(title));
  const extraTabs = [...tabs.keys()].filter((title) => !spec.tabOrder.includes(title));
  const orderedTabTitles = [...knownTabs, ...extraTabs];

  return orderedTabTitles.map((tabTitle) => {
    const sections = tabs.get(tabTitle) as Map<string, EditorField[]>;
    const order = spec.sectionOrder[tabTitle] ?? [];
    const orderedSections = [...sections.entries()]
      .sort((a, b) => rank(order, a[0]) - rank(order, b[0]))
      .map(([title, sectionFields]) => ({
        title,
        fields: sectionFields.sort((a, b) => a.label.localeCompare(b.label)),
      }));
    return { title: tabTitle, sections: orderedSections };
  });
}
