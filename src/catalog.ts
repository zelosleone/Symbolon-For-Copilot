import { API_BASE, apiHeaders, type Session } from './chatgpt.js';

// Codex's own bundled catalog: the same schema the account's /models returns.
const CODEX_MODELS_JSON = 'https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json';
// The catalog hides models whose minimal_client_version is newer than this, so ask as the newest client.
const CLIENT_VERSION = '99.0.0';

export interface ReasoningLevel {
  effort: string;
  description?: string;
}

export interface ServiceTier {
  id: string;
  name?: string;
  description?: string;
}

/** One entry of a Codex `models.json` catalog; only the fields this extension reads. */
export interface CatalogModel {
  slug: string;
  display_name?: string;
  description?: string | null;
  visibility?: string;
  priority?: number;
  context_window?: number | null;
  effective_context_window_percent?: number;
  input_modalities?: string[];
  default_reasoning_level?: string | null;
  supported_reasoning_levels?: ReasoningLevel[];
  supports_reasoning_summaries?: boolean;
  support_verbosity?: boolean;
  default_verbosity?: string | null;
  supports_parallel_tool_calls?: boolean;
  use_responses_lite?: boolean;
  service_tiers?: ServiceTier[];
  default_service_tier?: string | null;
  available_in_plans?: string[];
}

class CatalogError extends Error {
  constructor(
    readonly status: number,
    detail = '',
  ) {
    super(`Model catalog request failed (HTTP ${status}). ${detail.slice(0, 300)}`.trim());
  }
}

/** The signed-in account's models, in the models.json schema. */
export async function fetchAccountCatalog(session: Session): Promise<CatalogModel[]> {
  const res = await fetch(`${API_BASE}/models?client_version=${CLIENT_VERSION}`, {
    headers: { ...apiHeaders(session), Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new CatalogError(res.status, await res.text());
  const models = readModels(await res.json());
  if (models.length === 0) throw new CatalogError(200, 'The account catalog was empty.');
  return models;
}

/** Codex's published models.json, narrowed to the account's plan, for when /models is unavailable. */
export async function fetchCodexCatalog(plan: string | undefined): Promise<CatalogModel[]> {
  const res = await fetch(CODEX_MODELS_JSON, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new CatalogError(res.status);
  return readModels(await res.json()).filter((model) => !plan || !model.available_in_plans || model.available_in_plans.includes(plan));
}

function readModels(body: unknown): CatalogModel[] {
  const models = (body as { models?: unknown }).models;
  if (!Array.isArray(models)) throw new CatalogError(200, 'The catalog had no models array.');
  return models.filter((model): model is CatalogModel => typeof (model as CatalogModel)?.slug === 'string');
}
