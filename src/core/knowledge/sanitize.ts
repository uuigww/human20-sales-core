/**
 * Санитайзер документов для RAG-индексации. Вырезает инъекционные конструкции из чанков
 * ПЕРЕД эмбеддингом — защита от indirect prompt injection через отравленный документ.
 * Использует общие INJECTION_PATTERNS (единый источник правды с входным guard'ом).
 */

import { INJECTION_PATTERNS } from '../injectionGuard.js';

export interface SanitizeResult {
  /** Очищенный текст (инъекционные спаны заменены пробелом, схлопнуты пробелы). */
  clean: string;
  /** Что было вырезано (для лога/аудита). */
  removed: string[];
  /** Коды с провенансом вида `<sourceId>:<code>`. */
  flags: string[];
}

export function sanitizeKnowledgeChunk(text: string, sourceId: string): SanitizeResult {
  let clean = text;
  const removed: string[] = [];
  const flags: string[] = [];

  for (const p of INJECTION_PATTERNS) {
    if (!p.re.test(clean)) continue;
    flags.push(`${sourceId}:${p.code}`);
    // Глобальная версия паттерна — убрать ВСЕ вхождения, а не только первое.
    const g = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g');
    clean = clean.replace(g, (hit) => {
      removed.push(hit);
      return ' ';
    });
  }

  return { clean: clean.replace(/[ \t]{2,}/g, ' ').trim(), removed, flags };
}
