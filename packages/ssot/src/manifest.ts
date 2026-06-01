/**
 * Манифест источников знаний для RAG. Серверный индексатор берёт этот список,
 * читает файлы и кладёт чанки+эмбеддинги в pgvector (см. scripts/ingest-knowledge.ts в core).
 *
 * Добавляешь новый документ по проекту → добавляешь запись сюда → переиндексация. Один список правды.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));

export type KnowledgeKind = 'offer' | 'boundaries' | 'faq' | 'doc';

export interface KnowledgeSource {
  id: string;
  title: string;
  /** Имя файла в пакете ssot (рядом с этим модулем). */
  file: string;
  kind: KnowledgeKind;
  /** Краткое описание — попадёт в метаданные чанка. */
  description: string;
}

export const KNOWLEDGE_SOURCES: KnowledgeSource[] = [
  {
    id: 'offer',
    title: 'Оффер и тарифная лестница',
    file: 'offer.md',
    kind: 'offer',
    description: 'Линейка 18k/48k/200k/1.5M + Среда: состав, цены, для кого, что НЕ обещаем.',
  },
  {
    id: 'boundaries',
    title: 'Границы и политики',
    file: 'boundaries.md',
    kind: 'boundaries',
    description: 'Жёсткие правила: автономность по тарифам, гарантии/возвраты (оферта), 48k не «аренда».',
  },
];

/** Прочитать содержимое источника (для индексатора RAG). */
export function readKnowledgeSource(src: KnowledgeSource): string {
  return readFileSync(join(here, src.file), 'utf8');
}

/** Манифест с уже прочитанным содержимым — удобно для ingest. */
export function knowledgeManifest(): Array<KnowledgeSource & { content: string }> {
  return KNOWLEDGE_SOURCES.map((s) => ({ ...s, content: readKnowledgeSource(s) }));
}

/** Весь продуктовый нарратив одним текстом (для StaticKnowledgeProvider — без RAG). */
export function loadProductNarrative(): string {
  return KNOWLEDGE_SOURCES.map((s) => `# ${s.title}\n\n${readKnowledgeSource(s)}`).join('\n\n---\n\n');
}

function byId(id: string): KnowledgeSource {
  const s = KNOWLEDGE_SOURCES.find((x) => x.id === id);
  if (!s) throw new Error(`SSOT: источник '${id}' не найден в манифесте`);
  return s;
}

/** Только оффер (RAG-able продуктовое знание). */
export function loadOffer(): string {
  return readKnowledgeSource(byId('offer'));
}

/**
 * Только границы. Это safety-critical правила — promptAssembler инжектит их ВСЕГДА статически,
 * не через RAG (нельзя, чтобы границы зависели от качества ретрива).
 */
export function loadBoundaries(): string {
  return readKnowledgeSource(byId('boundaries'));
}
