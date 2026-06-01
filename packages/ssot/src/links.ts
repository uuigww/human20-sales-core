/**
 * РЕЕСТР ССЫЛОК (вайтлист). Единственный источник ссылок, которые бот может дать.
 *
 * Как работает защита от «левых» ссылок:
 *  1. Модель НЕ пишет сырые URL в текст. Чтобы дать ссылку — добавляет её id в поле `links`.
 *  2. Движок резолвит id → реальный URL отсюда. Неизвестные id отбрасываются.
 *  3. Guardrail сканирует ответ и режет ЛЮБОЙ URL/домен, которого нет в этом реестре.
 *  → даже если модель «придумает» ссылку, до пользователя она не дойдёт.
 *
 * ⚠️ ЗАПОЛНИ реальные URL ниже (ready:false = заглушка). Платёжные ссылки сюда НЕ кладём —
 *    они динамические (QR Tochka на заказ) и идут через action give_payment_link.
 */

export interface LinkEntry {
  id: string;
  /** Как назвать ссылку человеку. */
  title: string;
  /** Реальный URL. Заполнить перед продом, если ready:false. */
  url: string;
  /** Куда ведёт — для понимания моделью. */
  description: string;
  /** Когда бот её предлагает. */
  whenToUse: string;
  /** Разрешить ЛЮБОЙ путь на этом хосте (для нашего сайта). */
  hostWildcard?: boolean;
  /** false = URL-заглушка, заменить на реальный. */
  ready: boolean;
}

export const LINKS: Record<string, LinkEntry> = {
  site: {
    id: 'site',
    title: 'Сайт «Человек 2.0»',
    url: 'https://human20.app',
    description: 'Главный сайт: линейка, среда, оплата. Эталон позиционирования.',
    whenToUse: 'Когда человек хочет «посмотреть подробнее» / общий обзор продукта.',
    hostWildcard: true,
    ready: true,
  },
  payment_page: {
    id: 'payment_page',
    title: 'Страница оплаты',
    url: 'https://human20.app/payment',
    description: 'Страница выбора формата и оплаты по QR (воркшоп 18k, Среда).',
    whenToUse: 'Когда ведёшь к оплате воркшопа/Среды и нужен общий вход на оплату.',
    ready: true,
  },
  demo_bot: {
    id: 'demo_bot',
    title: 'Демо-агент',
    url: 'https://t.me/REPLACE_demo_bot',
    description: 'Лид-магнит: бот, в котором можно «потрогать» ИИ-агента до покупки.',
    whenToUse: 'Сомневается / просто смотрит / «дорого» / хочет доказательство — даём демо.',
    ready: false,
  },
  channel: {
    id: 'channel',
    title: 'Telegram-канал @human20',
    url: 'https://t.me/human20',
    description: 'Канал проекта: прогрев, кейсы, свежие фишки, комьюнити.',
    whenToUse: 'Не готов покупать, но интересно — зовём подписаться и следить.',
    ready: true,
  },
  oferta: {
    id: 'oferta',
    title: 'Публичная оферта',
    url: 'https://human20.app/oferta',
    description: 'Юридические условия, включая возврат. Бот ТОЛЬКО ссылается, не пересказывает.',
    whenToUse: 'Вопросы про гарантии/возврат/условия — даём ссылку на оферту.',
    ready: false,
  },
  manager: {
    id: 'manager',
    title: 'Менеджер @chipmanager',
    url: 'https://t.me/chipmanager',
    description: 'Живой человек: high-ticket (200k+), 48k без scope, юр./нестандартные вопросы.',
    whenToUse: 'Передача живому: 200k+/enterprise, 48k без зафиксированного scope, по просьбе.',
    ready: true,
  },
  waitlist: {
    id: 'waitlist',
    title: 'Лист ожидания потока',
    url: 'https://human20.app/waitlist',
    description: 'Предзапись на воркшоп до открытия продаж — ранняя цена.',
    whenToUse: 'Тёплый, но «не сейчас»/до старта продаж — записываем в лист ожидания.',
    ready: false,
  },
  // --- Соцсети (заполнить URL; добавляй сюда новые каналы по аналогии) ---
  vk: {
    id: 'vk',
    title: 'Сообщество ВКонтакте',
    url: 'https://vk.com/REPLACE_human20',
    description: 'Зеркало проекта во ВКонтакте.',
    whenToUse: 'Человеку удобнее ВК — даём ВК-сообщество.',
    ready: false,
  },
};

export interface ResolvedLink {
  id: string;
  title: string;
  url: string;
  ready: boolean;
}

export function listLinks(): LinkEntry[] {
  return Object.values(LINKS);
}

/** Каталог ссылок для промпта: модель выбирает строго по id. */
export function linkCatalog(): string {
  return listLinks()
    .map(
      (l) =>
        `- id: ${l.id} — ${l.title}${l.ready ? '' : ' (URL ещё не заполнен)'}\n` +
        `    куда ведёт: ${l.description}\n` +
        `    когда давать: ${l.whenToUse}`,
    )
    .join('\n');
}

/** Резолвит id → ссылки. Неизвестные id отбрасываются и возвращаются отдельно. */
export function resolveLinkIds(ids: string[]): { resolved: ResolvedLink[]; unknown: string[] } {
  const resolved: ResolvedLink[] = [];
  const unknown: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    const entry = LINKS[id];
    if (entry) resolved.push({ id: entry.id, title: entry.title, url: entry.url, ready: entry.ready });
    else unknown.push(id);
  }
  return { resolved, unknown };
}

// ---------- Проверка «левых» ссылок в тексте ----------

function normalizeUrl(s: string): string {
  return s
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/[).,;!?'"»]+$/u, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

const WILDCARD_HOSTS = new Set(
  listLinks()
    .filter((l) => l.hostWildcard)
    .map((l) => normalizeUrl(l.url).split('/')[0]!),
);

const ALLOWED_EXACT = new Set(listLinks().map((l) => normalizeUrl(l.url)));

/** Находит в тексте кандидаты в URL (домены/ссылки). TLD обязан быть буквенным — числа не ловим. */
export function extractUrlCandidates(text: string): string[] {
  const re =
    /(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/[^\s)<>"']*)?/gi;
  return text.match(re) ?? [];
}

/** Разрешён ли конкретный URL: хост в вайтлисте (wildcard) или точное совпадение. */
export function isAllowedUrl(candidate: string): boolean {
  const n = normalizeUrl(candidate);
  const host = n.split('/')[0]!;
  for (const w of WILDCARD_HOSTS) {
    if (host === w || host.endsWith('.' + w)) return true;
  }
  return ALLOWED_EXACT.has(n);
}

/** Все «не наши» ссылки в тексте (для guardrail). */
export function findUnlistedUrls(text: string): string[] {
  return extractUrlCandidates(text).filter((u) => !isAllowedUrl(u));
}
