import type * as vscode from 'vscode';
import type { CatalogModel, ReasoningLevel, ServiceTier } from './catalog.js';

const DEFAULT_TIER = 'default';
// Codex's own budget when a catalog entry doesn't say: use 95% of the window for input.
const DEFAULT_EFFECTIVE_PERCENT = 95;

type Choice = Record<string, unknown> & { enum: string[]; default: string };

interface Schema {
  properties: { reasoningEffort?: Choice; serviceTier?: Choice };
}

/** How requests for this model are shaped, read from its catalog entry. */
interface RequestShape {
  lite: boolean;
  summaries: boolean;
  verbosity?: string;
  parallelToolCalls: boolean;
}

export type SymbolonModel = vscode.LanguageModelChatInformation & {
  readonly isBYOK: true;
  readonly maxContextWindowTokens: number;
  readonly configurationSchema?: Schema;
  readonly request: RequestShape;
};

export function toModels(catalog: CatalogModel[]): SymbolonModel[] {
  return catalog
    .filter((model) => model.visibility === 'list' && (model.context_window ?? 0) > 0)
    .sort((a, b) => (a.priority ?? 1e6) - (b.priority ?? 1e6))
    .map(toModel);
}

function toModel(model: CatalogModel): SymbolonModel {
  const context = model.context_window as number;
  const percent = model.effective_context_window_percent ?? DEFAULT_EFFECTIVE_PERCENT;
  const maxInputTokens = Math.floor((context * percent) / 100);
  return {
    id: model.slug,
    name: model.display_name || model.slug,
    family: model.slug,
    version: model.slug,
    tooltip: [model.description, 'Using ChatGPT plan.'].filter(Boolean).join(' '),
    detail: 'ChatGPT plan',
    maxInputTokens,
    maxOutputTokens: context - maxInputTokens,
    maxContextWindowTokens: context,
    capabilities: { toolCalling: true, imageInput: model.input_modalities?.includes('image') === true },
    isBYOK: true,
    configurationSchema: schema(model),
    request: {
      lite: model.use_responses_lite === true,
      summaries: model.supports_reasoning_summaries === true,
      verbosity: model.support_verbosity ? (model.default_verbosity ?? undefined) : undefined,
      parallelToolCalls: model.supports_parallel_tool_calls === true && model.use_responses_lite !== true,
    },
  };
}

function schema(model: CatalogModel): Schema | undefined {
  const reasoningEffort = effortChoice(model.supported_reasoning_levels ?? [], model.default_reasoning_level);
  const serviceTier = tierChoice(model.service_tiers ?? [], model.default_service_tier);
  if (!reasoningEffort && !serviceTier) return undefined;
  return { properties: { ...(reasoningEffort && { reasoningEffort }), ...(serviceTier && { serviceTier }) } };
}

// In-picker options, built only from what the catalog lists for this model.
function effortChoice(levels: ReasoningLevel[], fallback?: string | null): Choice | undefined {
  if (levels.length === 0) return undefined;
  const efforts = levels.map((level) => level.effort);
  return {
    type: 'string',
    title: 'Reasoning Effort',
    enum: efforts,
    enumItemLabels: efforts.map(label),
    enumDescriptions: levels.map((level) => level.description ?? ''),
    default: fallback && efforts.includes(fallback) ? fallback : (efforts[0] as string),
    group: 'navigation',
  };
}

function tierChoice(tiers: ServiceTier[], fallback?: string | null): Choice | undefined {
  if (tiers.length === 0) return undefined;
  const ids = [DEFAULT_TIER, ...tiers.map((tier) => tier.id)];
  return {
    type: 'string',
    title: 'Speed',
    enum: ids,
    enumItemLabels: ['Standard', ...tiers.map((tier) => tier.name ?? label(tier.id))],
    enumDescriptions: ['Standard speed and usage', ...tiers.map((tier) => tier.description ?? '')],
    default: fallback && ids.includes(fallback) ? fallback : DEFAULT_TIER,
    group: 'navigation',
  };
}

// "xhigh" reads as "Extra High"; other levels are title-cased as they come.
function label(value: string): string {
  const words = value.replace(/^x(?=[a-z]{3,})/, 'extra ').split(/[\s_-]+/);
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

export function configured(model: SymbolonModel, options: Record<string, unknown>, key: 'reasoningEffort' | 'serviceTier'): string | undefined {
  const choice = model.configurationSchema?.properties[key];
  if (!choice) return undefined;
  const config = (options.modelConfiguration ?? options.configuration) as Record<string, unknown> | undefined;
  const value = config?.[key];
  return typeof value === 'string' && choice.enum.includes(value) ? value : choice.default;
}

export { DEFAULT_TIER };
