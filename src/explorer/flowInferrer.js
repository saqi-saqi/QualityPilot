/**
 * flowInferrer.js — propose user flows from crawled pages.
 *
 * Strategy:
 *   1. Filter pages down to ones with forms, buttons, or notable API calls.
 *   2. Send the structured summary to the LLM via flowInferencePrompt.
 *   3. Parse the JSON response; normalize to TestPlan Flow[] shape.
 *   4. Drop any flow that fails Zod validation against the Flow schema —
 *      the LLM is allowed to be imperfect; we silently discard bad output
 *      rather than poisoning the plan.
 *   5. Hallucination pre-check: compare each flow's startUrl + first-step
 *      selector against the structural data the crawler actually captured
 *      (links, inputDetails, imageDetails, titles). Flows referencing
 *      elements never seen in the crawl are marked needsReview: true (still
 *      included — the plan review UI surfaces them) and a warning is added
 *      to the plan's warnings array. Heuristic + cheap; no extra LLM calls.
 */
import { chatJson } from './llmProvider.js';
import { flowInferencePrompt } from './prompts.js';
import { TestPlan, arrayElementSchema } from '../services/testPlan.js';

const FlowSchema = arrayElementSchema(TestPlan.shape.flows);

/**
 * Collect lowercase "identifying fragments" observed anywhere in the crawl:
 * URLs + paths, link hrefs, input/image selector fragments (ids, names,
 * data-testids, classes), titles and h1 text. Cheap string work only.
 */
export function collectObservedTokens(pages) {
  const tokens = new Set();
  const add = (v) => {
    if (typeof v === 'string' && v.trim()) tokens.add(v.trim().toLowerCase());
  };

  for (const page of pages || []) {
    add(page.url);
    try { add(new URL(page.url, 'https://scope.invalid').pathname); } catch { /* ignore */ }
    add(page.title);
    add(page.meta?.h1);
    for (const link of page.links || []) {
      add(link);
      try { add(new URL(link, page.url || 'https://scope.invalid').pathname); } catch { /* ignore */ }
    }
    for (const input of page.inputDetails || []) {
      add(input.selector);
      add(input.formSelector);
    }
    for (const img of page.imageDetails || []) {
      add(img.selector);
      add(img.src);
      add(img.alt);
    }
    for (const call of page.apiCalls || []) {
      add(call.url);
      try { add(new URL(call.url).pathname); } catch { /* ignore */ }
    }
    if (typeof page.ariaSnapshot === 'string' && page.ariaSnapshot) {
      // Parse accessible names, refs, and roles from ARIA snapshot
      const nameMatches = page.ariaSnapshot.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g);
      for (const m of nameMatches) {
        if (m[1]) add(m[1]);
      }
      const refMatches = page.ariaSnapshot.matchAll(/\[ref=([^\]]+)\]/g);
      for (const m of refMatches) {
        if (m[1]) {
          add(m[1]);
          add(`aria-ref=${m[1]}`);
          add(`[aria-ref="${m[1]}"]`);
        }
      }
      const roleMatches = page.ariaSnapshot.matchAll(/(?:^|\n)\s*(?:-\s*)?([a-z]+)/gi);
      for (const m of roleMatches) {
        if (m[1]) add(m[1]);
      }
    }
  }
  return tokens;
}

/**
 * Extract the checkable identifying fragments a selector references:
 * id fragments (#x), name/testid/aria-label attribute values, class
 * fragments (.x), and href attribute values. Pure tag/nth-of-type selectors
 * yield no fragments (can't be pre-checked — not flagged).
 */
export function selectorFragments(selector) {
  if (typeof selector !== 'string') return [];
  const fragments = [];
  const patterns = [
    /#([\w-]+)/g,                                   // ids
    /\[(?:data-testid|data-test|name|aria-label|href|id|class)=["']?([^\]"']+)["']?\]/gi,
    /\.([A-Za-z_][\w-]*)/g,                         // classes
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(selector)) !== null) {
      if (m[1]) fragments.push(m[1].toLowerCase());
    }
  }
  return [...new Set(fragments)];
}

function normalizeStartUrlPath(url) {
  try {
    return new URL(url).pathname.replace(/\/+$/, '') || '/';
  } catch {
    return null;
  }
}

/**
 * Heuristic hallucination check for a single flow. Returns a reason string
 * when the flow references something never seen in the crawl, else null.
 */
export function checkFlowAgainstCrawl(flow, observedTokens, pages) {
  if (!(observedTokens instanceof Set) || observedTokens.size === 0) return null;

  // 1. startUrl must look like something the crawler saw (exact URL or path).
  const startPath = normalizeStartUrlPath(flow.startUrl);
  const startSeen = observedTokens.has(String(flow.startUrl).toLowerCase())
    || (startPath && [...observedTokens].some(t => t === startPath || t.endsWith(startPath) || startPath.endsWith(t)));
  if (!startSeen) {
    return `startUrl "${flow.startUrl}" was never seen in the crawl`;
  }

  // 2. The first step that targets an element: its identifying fragments
  //    must ALL be unknown for us to flag (partial overlap = fine).
  const firstTargeted = (flow.steps || []).find(s => typeof s.selector === 'string' && s.selector.trim());
  if (firstTargeted) {
    const fragments = selectorFragments(firstTargeted.selector);
    if (fragments.length && !fragments.some(f => [...observedTokens].some(t => t.includes(f)))) {
      return `first-step selector "${firstTargeted.selector}" references elements never seen in the crawl`;
    }
  }
  return null;
}

/**
 * Attach `needsReview: true` to a flow — but only when the CURRENT Flow
 * schema accepts the flag (testPlan.js is owned by another agent and may
 * add it in this or a later pass). Never let the extra key break plan
 * validation; the warning is emitted regardless.
 */
function withNeedsReview(flow, reason, warnings) {
  const name = flow?.name || 'unnamed';
  warnings.push(`Flow "${name}" flagged for review: ${reason}.`);
  try {
    const probe = FlowSchema.safeParse({ ...flow, needsReview: true });
    if (probe.success) {
      return { ...flow, needsReview: true };
    }
  } catch { /* schema probe failed — warn only */ }
  return flow;
}

export async function inferFlows({ pages, llmOpts = {} }) {
  if (!pages || pages.length === 0) return [];

  // Only consider pages that have something testable
  const interesting = pages.filter(p =>
    (p.forms && p.forms > 0) ||
    (p.buttons && p.buttons > 0) ||
    (p.inputs && p.inputs > 0) ||
    (p.apiCalls && p.apiCalls.length > 0)
  );

  if (interesting.length === 0) return [];

  const { system, user } = flowInferencePrompt({ pages: interesting });
  const result = await chatJson({ system, user, temperature: 0.3 }, llmOpts);

  if (!result.ok) {
    return {
      flows: [],
      warnings: [`Flow inference failed: ${result.error}`],
    };
  }

  const rawFlows = Array.isArray(result.data?.flows) ? result.data.flows : [];

  // Validate + normalize each flow. Drop invalid ones silently.
  const flows = [];
  const warnings = [];
  const observedTokens = collectObservedTokens(pages);
  const crawledOrigins = new Set(
    (pages || [])
      .map(p => {
        try { return new URL(p.url).origin; } catch { return null; }
      })
      .filter(Boolean)
  );

  for (const raw of rawFlows) {
    const parsed = FlowSchema.safeParse(raw);
    if (parsed.success) {
      const flowData = parsed.data;
      // Strip any upload action steps or steps containing secretRef from LLM-generated flows
      const safeSteps = (flowData.steps || [])
        .filter(s => s.action !== 'upload')
        .map(s => {
          if (s.auth?.secretRef) {
            const { secretRef: _, ...restAuth } = s.auth;
            return { ...s, auth: restAuth };
          }
          return s;
        });

      // Validate that startUrl stays on the crawled origins
      try {
        const startOrigin = new URL(flowData.startUrl).origin;
        if (crawledOrigins.size > 0 && !crawledOrigins.has(startOrigin)) {
          warnings.push(`Dropped flow "${flowData.name || 'unnamed'}": startUrl is not on a crawled origin.`);
          continue;
        }
      } catch {
        warnings.push(`Dropped flow "${flowData.name || 'unnamed'}": invalid startUrl.`);
        continue;
      }

      const sanitizedFlow = { ...flowData, steps: safeSteps };
      const hallucination = checkFlowAgainstCrawl(sanitizedFlow, observedTokens, pages);
      flows.push(
        hallucination
          ? withNeedsReview(sanitizedFlow, hallucination, warnings)
          : sanitizedFlow
      );
    } else {
      const issues = parsed.error.issues
        .map(i => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      warnings.push(`Dropped invalid flow "${raw?.name || 'unnamed'}": ${issues}`);
    }
  }

  return { flows, warnings };
}
