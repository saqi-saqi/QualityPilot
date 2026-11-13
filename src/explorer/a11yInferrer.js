/**
 * a11yInferrer.js — propose accessibility rules to enforce.
 *
 * The default rule set is the FULL WCAG-tagged axe universe: every axe-core
 * rule tagged wcag2a, wcag2aa, wcag21a or wcag21aa (imported from the
 * compliance mapping — axe rules that map to a WCAG 2.x A/AA success
 * criterion). Page-specific pruning still applies (e.g. no images anywhere
 * → drop image-alt). The a11y executor additionally re-fetches the live
 * rule list via axe.getRules(...) inside the page, so unknown-to-this-build
 * rule IDs are filtered at run time.
 *
 * The old fast subset is available ONLY as an explicit fast: true option.
 */
import { TestPlan, arrayElementSchema } from '../services/testPlan.js';
import { WCAG_AXE_RULE_UNIVERSE } from '../services/compliance.js';

const A11yRuleSchema = arrayElementSchema(TestPlan.shape.a11yRules);

// Severity defaults per rule — presentation only (the a11y executor takes
// real impact from axe's own report); the schema requires a valid level.
const LEVEL_BY_RULE = {
  'image-alt': 'critical',
  'label': 'critical',
  'button-name': 'critical',
  'link-name': 'critical',
  'aria-required-attr': 'critical',
  'aria-roles': 'critical',
  'aria-hidden-focus': 'critical',
  'aria-input-field-name': 'critical',
  'aria-command-name': 'critical',
  'aria-toggle-field-name': 'critical',
  'select-name': 'critical',
  'input-button-name': 'critical',
  'nested-interactive': 'serious',
  'color-contrast': 'serious',
  'html-has-lang': 'serious',
  'bypass': 'serious',
  'valid-lang': 'moderate',
  'meta-refresh': 'serious',
};

// Explicit fast mode only — a small smoke-test subset, NOT the default.
export const FAST_RULES = [
  { rule: 'color-contrast', level: 'serious' },
  { rule: 'image-alt',      level: 'critical' },
  { rule: 'label',          level: 'critical' },
  { rule: 'button-name',    level: 'critical' },
  { rule: 'link-name',      level: 'critical' },
  { rule: 'html-has-lang',  level: 'serious' },
  { rule: 'document-title', level: 'serious' },
];

/**
 * Build the default rule set: the full WCAG-tagged axe universe with
 * page-aware pruning.
 */
function buildFullRuleSet({ pages }) {
  const rules = WCAG_AXE_RULE_UNIVERSE.map(({ rule }) => ({
    rule,
    level: LEVEL_BY_RULE[rule] || 'serious',
  }));

  // Page-specific pruning — avoid noise where the content type can't occur.
  // (Phase 1 keeps this minimal — Phase 2 can add per-page scoping.)
  const hasImages = (pages || []).some(p => p.imageDetails && p.imageDetails.length > 0);
  const hasForms = (pages || []).some(p => p.forms && p.forms > 0);

  // If no forms anywhere, drop the form-label rules (avoids noise).
  if (!hasForms) {
    for (const formRule of ['label', 'form-field-multiple-labels']) {
      const idx = rules.findIndex(r => r.rule === formRule);
      if (idx >= 0) rules.splice(idx, 1);
    }
  }
  // If no images anywhere, drop image-dependent rules.
  if (!hasImages) {
    for (const imgRule of ['image-alt', 'input-image-alt', 'role-img-alt', 'svg-img-alt', 'object-alt', 'area-alt', 'aria-meter-name', 'aria-progressbar-name']) {
      const idx = rules.findIndex(r => r.rule === imgRule);
      if (idx >= 0) rules.splice(idx, 1);
    }
  }
  // No media anywhere → drop media rules.
  const hasMedia = (pages || []).some(p =>
    (p.links || []).some(l => /\.(mp4|webm|mp3|ogg|wav)(\?|$)/i.test(l)) ||
    (p.imageDetails || []).some(i => /\.(mp4|webm|mp3|ogg|wav)(\?|$)/i.test(i.src || ''))
  );
  if (!hasMedia) {
    for (const mediaRule of ['audio-caption', 'video-caption', 'no-autoplay-audio']) {
      const idx = rules.findIndex(r => r.rule === mediaRule);
      if (idx >= 0) rules.splice(idx, 1);
    }
  }
  // Table rules stay in the set: the crawler doesn't capture table counts
  // yet, and axe reports not-applicable rules as passes, not violations.

  return rules;
}

export function inferA11yRules({ pages, fast = false } = {}) {
  const rules = fast === true ? FAST_RULES.map(r => ({ ...r })) : buildFullRuleSet({ pages });

  // Validate each rule against the schema (defense-in-depth — schema is
  // strict so we want to catch any drift between this list and the schema).
  return rules
    .map(r => A11yRuleSchema.safeParse(r))
    .filter(r => r.success)
    .map(r => r.data);
}
