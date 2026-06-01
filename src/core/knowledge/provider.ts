/**
 * KnowledgeProvider — откуда core берёт продуктовые знания для промпта.
 *  - StaticKnowledgeProvider (дефолт) — весь оффер из пакета @human20/ssot (как сейчас).
 *  - RagKnowledgeProvider — на сервере: ретривит релевантные чанки из pgvector по текущему запросу.
 *
 * ВАЖНО: границы (boundaries) и валидация цен/ссылок НЕ идут через провайдер — они всегда статичны
 * из @human20/ssot (см. promptAssembler и guardrails). Провайдер отвечает только за «понимание» оффера.
 */

import { loadOffer } from '@human20/ssot';

export interface KnowledgeProvider {
  /** Продуктовый контекст для промпта. query — текущее сообщение (нужно RAG-ретриверу). */
  productContext(query?: string): Promise<string>;
}

/** Дефолт: весь оффер из пакета, без RAG. */
export class StaticKnowledgeProvider implements KnowledgeProvider {
  private cached: string | undefined;
  async productContext(_query?: string): Promise<string> {
    if (this.cached === undefined) this.cached = loadOffer();
    return this.cached;
  }
}

export interface KnowledgeChunk {
  title?: string;
  content: string;
}

/** Функция ретрива (реализует сервер поверх pgvector). */
export type RetrieveFn = (query: string, topK: number) => Promise<KnowledgeChunk[]>;

/**
 * RAG-провайдер для сервера. При пустом query или сбое ретрива — безопасный фолбэк на статику,
 * чтобы продажник никогда не остался без знаний о продукте.
 */
export class RagKnowledgeProvider implements KnowledgeProvider {
  constructor(
    private retrieve: RetrieveFn,
    private topK = 6,
    private fallback: KnowledgeProvider = new StaticKnowledgeProvider(),
  ) {}

  async productContext(query?: string): Promise<string> {
    if (!query?.trim()) return this.fallback.productContext();
    try {
      const chunks = await this.retrieve(query, this.topK);
      if (!chunks.length) return this.fallback.productContext();
      return chunks.map((c) => (c.title ? `# ${c.title}\n${c.content}` : c.content)).join('\n\n---\n\n');
    } catch {
      return this.fallback.productContext();
    }
  }
}

export const defaultKnowledge: KnowledgeProvider = new StaticKnowledgeProvider();
