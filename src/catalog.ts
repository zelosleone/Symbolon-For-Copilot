import { RESOURCE } from './siwc.js';

// Codex's own bundled catalog: the same schema the account's /v1/models returns.
const CODEX_MODELS_JSON = 'https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json';

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
  supported_in_api?: boolean;
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
}

class CatalogError extends Error {
  constructor(
    readonly status: number,
    detail = '',
  ) {
    super(`Model catalog request failed (HTTP ${status}). ${detail.slice(0, 300)}`.trim());
  }
}

/** The signed-in account's catalog, in the models.json schema. */
export async function fetchAccountCatalog(accessToken: string): Promise<CatalogModel[]> {
  const res = await fetch(`${RESOURCE}/models`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new CatalogError(res.status, await res.text());
  return readModels(await res.json());
}

/** Codex's bundled models.json, used when the account catalog is unavailable. */
export async function fetchCodexCatalog(): Promise<CatalogModel[]> {
  const res = await fetch(CODEX_MODELS_JSON, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new CatalogError(res.status);
  // The bundled file also lists models the public Responses API doesn't serve.
  return readModels(await res.json()).filter((model) => model.supported_in_api !== false);
}

function readModels(body: unknown): CatalogModel[] {
  const models = (body as { models?: unknown }).models;
  if (!Array.isArray(models)) throw new CatalogError(200, 'The catalog had no models array.');
  return models.filter((model): model is CatalogModel => typeof (model as CatalogModel)?.slug === 'string');
}
