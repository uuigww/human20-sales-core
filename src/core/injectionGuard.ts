/**
 * InjectionGuard — детектор prompt injection на ВХОДЕ. Детерминированный, дешёвый, 0 токенов.
 * Паттерны общие с RAG-санитайзером (knowledge/sanitize.ts) — единый источник правды.
 *
 * \b/\w в JS-regex — только ASCII и не матчат кириллицу; для рус. границ используем [а-яё]/края строки.
 */

export interface InjectionPattern {
  re: RegExp;
  weight: number;
  code: string;
}

export const INJECTION_PATTERNS: readonly InjectionPattern[] = [
  // — перехват инструкций (однозначно → hard)
  { code: 'ignore_prev', weight: 5, re: /ignore\s+(?:all\s+|the\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|messages?)/i },
  { code: 'disregard_above', weight: 5, re: /disregard\s+(?:all\s+|the\s+)?(?:previous|above|prior|earlier)/i },
  { code: 'forget_rules_ru', weight: 5, re: /забудь\s+(?:все\s+|свои\s+|предыдущие\s+|данные\s+тебе\s+)?(?:инструкци|правил|указани|настройк)/i },
  { code: 'ignore_rules_ru', weight: 5, re: /(?:не\s+обращай\s+внимани[а-яё]*\s+на|игнорируй)\s+(?:[а-яёa-z\s]{0,20})?(?:инструкци|правил|указани)/i },
  // — ролевые токены / разделители (однозначно → hard)
  { code: 'role_token', weight: 5, re: /<\|im_(?:start|end)\|>|<\/?(?:system|assistant|user)>|\[\/?(?:system|inst)\]/i },
  { code: 'code_system', weight: 5, re: /```+\s*system/i },
  // — извлечение/подмена системного промпта (однозначно → hard).
  //   ВАЖНО: голое «инструкция» НЕ должно давать hard — клиент часто просит
  //   «покажи инструкцию по подключению». Hard только при явном системном контексте.
  { code: 'reveal_prompt', weight: 5, re: /(?:reveal|show|print|repeat|tell\s+me)\s+(?:your\s+|the\s+)?(?:system\s+)?prompt/i },
  { code: 'reveal_prompt_ru', weight: 5, re: /(?:покажи|выведи|раскрой|повтори|напечатай)\s+(?:свой\s+|свои\s+|весь\s+)?(?:систем[а-яё]*\s+промпт|систем[а-яё]*\s+инструкци[а-яё]*)/i },
  // — спуфинг роли в начале строки (средний)
  { code: 'role_spoof', weight: 3, re: /(?:^|\n)\s*(?:system|assistant)\s*:/i },
  // — намеренное перекрытие с reveal_* для усиления явного запроса системного промпта
  { code: 'system_prompt', weight: 3, re: /system\s+prompt|систем[а-яё]*\s+промпт/i },
  // — запрос «покажи СВОИ инструкции/правила» (про самого бота, не про продукт) → soft
  { code: 'reveal_instruct', weight: 3, re: /(?:reveal|show|print|repeat)\s+your\s+(?:rules?|instructions?)|(?:покажи|выведи|раскрой|повтори)\s+(?:мне\s+)?(?:сво[ия]|твои)\s+(?:инструкци[а-яё]*|правил[а-яё]*)/i },
  // — смена роли/личности (формулировкой → soft, в комбинации → hard)
  { code: 'you_are_now', weight: 3, re: /you\s+are\s+now\s+(?:a\s+|an\s+|the\s+)?(?:dan|different|new|another|unrestricted|jailbroken)|ты\s+(?:теперь|больше\s+не)\s+(?:бот|агент|ассистент|ии|другой|новый)/i },
  { code: 'act_as', weight: 3, re: /\bact\s+as\b|pretend\s+to\s+be\b|представь,?\s+что\s+ты[\s,]|веди\s+себя\s+как[\s,]/i },
  // — jailbreak / dev-mode (средний)
  { code: 'jailbreak', weight: 3, re: /\bjailbreak\b|\bDAN\b|developer\s+mode|режим\s+разработчик/i },
  // — отключение фильтров/цензуры (без широкого «без ограничений» — это нормальная sales-фраза)
  { code: 'no_limits', weight: 3, re: /без\s+(?:цензур|фильтр)|отключи\s+(?:фильтр|цензур|ограничени|защит|безопасн)|ignore\s+(?:all\s+)?(?:safety|content)\s+(?:filter|polic)/i },
  // — мягкие сигналы (soft в одиночку)
  { code: 'your_rules', weight: 2, re: /твои\s+(?:систем[а-яё]*\s+)?(?:инструкци|настройк)/i },
  { code: 'ignore_guardrails', weight: 2, re: /ignore\s+your\s+(?:guardrails|rules|instructions|limits)/i },
];

/** Пороги суммарного веса: soft (флаг) и hard (блок). Переиспользуются InjectionGuard (Task 2). */
export const SCORE_THRESHOLD_SOFT = 2;
export const SCORE_THRESHOLD_HARD = 5;

/** Сумма весов сработавших паттернов + их коды. Чистая функция, без состояния. */
export function scanText(text: string): { score: number; codes: string[] } {
  let score = 0;
  const codes: string[] = [];
  for (const p of INJECTION_PATTERNS) {
    if (p.re.test(text)) {
      score += p.weight;
      codes.push(p.code);
    }
  }
  return { score, codes };
}
