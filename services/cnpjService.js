const axios = require('axios');
const https = require('https');

/**
 * Regex para localizar padrões de CNPJ com ou sem pontuação:
 * Ex: 00.000.000/0001-00, 00000000/0001-00 ou 00000000000100
 */
const CNPJ_REGEX = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g;

/**
 * Regex para localizar e-mails no HTML
 */
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
const MAILTO_REGEX = /mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;

/**
 * Regex para localizar links de WhatsApp e telefones brasileiros no HTML
 */
const WA_LINK_REGEX = /(?:wa\.me\/|api\.whatsapp\.com\/send\?[^"'\s>]*phone=)(\d{10,13})/gi;
const TEL_LINK_REGEX = /href=["']tel:([^"']+)["']/gi;
const BR_PHONE_TEXT_REGEX =
  /(?:\+?55\s?)?\((?:1[1-9]|2[12478]|3[1-578]|4[1-9]|5[1345]|6[1-9]|7[134579]|8[1-9]|9[1-9])\)\s?(?:9\s?\d{4}|\d{4})[\s.-]?\d{4}\b/g;

/**
 * Timeout padrão para scraping de cada página (4.5 segundos)
 */
const SCRAPE_TIMEOUT_MS = 4500;

/**
 * User-Agent comum de navegador moderno
 */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * CNPJs de plataformas agregadoras/terceiros que não pertencem ao restaurante em si
 */
const PLATFORM_CNPJ_BLOCKLIST = new Set([
  '14380200000121', // iFood.com Agência de Restaurantes Online S.A.
  '13347016000117', // Facebook Serviços Online do Brasil Ltda.
  '06990590000123'  // Google Brasil Internet Ltda.
]);

/**
 * Domínios e extensões falsos-positivos de e-mail para ignorar durante scraping
 */
const IGNORED_EMAIL_DOMAINS = new Set([
  'sentry.io',
  'sentry-next.wixpress.com',
  'wixpress.com',
  'wix.com',
  'example.com',
  'exemplo.com',
  'exemplo.com.br',
  'seudominio.com',
  'seudominio.com.br',
  'dominio.com',
  'dominio.com.br',
  'email.com',
  'wordpress.org',
  'w3.org',
  'schema.org',
  'googleapis.com',
  'cloudflare.com',
  'ifood.com.br',
  'facebook.com',
  'instagram.com',
  'linktr.ee',
  'google.com'
]);

const IGNORED_EMAIL_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.css', '.js', '.woff', '.woff2', '.ttf', '.eot',
  '.mp4', '.ico', '. map', '.json', '.xml'
];

/**
 * Agente HTTPS tolerante a certificados SSL expirados/autoassinados
 */
const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

/**
 * Remove qualquer caractere não numérico.
 * @param {string} value
 * @returns {string}
 */
function stripNonDigits(value) {
  if (!value || typeof value !== 'string') return '';
  return value.replace(/\D/g, '');
}

/**
 * Formata uma string de 14 dígitos no padrão oficial de CNPJ: 00.000.000/0001-00
 * @param {string} cnpj
 * @returns {string|null}
 */
function formatCnpj(cnpj) {
  const digits = stripNonDigits(cnpj);
  if (digits.length !== 14) return null;
  return digits.replace(
    /^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,
    '$1.$2.$3/$4-$5'
  );
}

/**
 * Valida matematicamente um CNPJ através do algoritmo oficial dos dígitos verificadores (Módulo 11).
 * @param {string} rawCnpj
 * @returns {boolean}
 */
function isValidCnpj(rawCnpj) {
  const digits = stripNonDigits(rawCnpj);

  if (digits.length !== 14) {
    return false;
  }

  if (/^(\d)\1{13}$/.test(digits)) {
    return false;
  }

  if (PLATFORM_CNPJ_BLOCKLIST.has(digits)) {
    return false;
  }

  const calcCheckDigit = (baseDigits, weights) => {
    let sum = 0;
    for (let i = 0; i < weights.length; i++) {
      sum += Number(baseDigits[i]) * weights[i];
    }
    const remainder = sum % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };

  const weightsFirst = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const weightsSecond = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

  const firstDigit = calcCheckDigit(digits.slice(0, 12), weightsFirst);
  if (firstDigit !== Number(digits[12])) {
    return false;
  }

  const secondDigit = calcCheckDigit(digits.slice(0, 13), weightsSecond);
  if (secondDigit !== Number(digits[13])) {
    return false;
  }

  return true;
}

/**
 * Normaliza e valida um número de telefone brasileiro (fixo 10 dígitos ou celular 11 dígitos).
 * Retorna objeto estruturado ou null se inválido.
 *
 * @param {string} rawPhone
 * @param {string} [source='Google'] - 'Google' | 'CNPJ' | 'Site'
 * @returns {{ digits: string, formatted: string, waNumber: string, isMobile: boolean, source: string } | null}
 */
function normalizeBrazilianPhone(rawPhone, source = 'Google') {
  if (!rawPhone || typeof rawPhone !== 'string') return null;

  let digits = stripNonDigits(rawPhone);
  if (!digits) return null;

  // Remove DDI 55 se tiver 12 ou 13 dígitos
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    digits = digits.slice(2);
  }

  // Remove zero inicial de operadora/DDD (ex: 011999998888)
  if (digits.startsWith('0') && (digits.length === 11 || digits.length === 12)) {
    digits = digits.slice(1);
  }

  if (digits.length !== 10 && digits.length !== 11) {
    return null;
  }

  const ddd = Number(digits.slice(0, 2));
  if (ddd < 11 || ddd > 99 || ddd % 10 === 0) {
    return null;
  }

  const numberPart = digits.slice(2);
  // Rejeita sequências repetidas como 999999999 ou 00000000
  if (/^(\d)\1+$/.test(numberPart)) {
    return null;
  }

  const isMobile = digits.length === 11 && numberPart.startsWith('9');
  const isValidLandline = digits.length === 10 && /^[2-5]/.test(numberPart);

  if (!isMobile && !isValidLandline) {
    return null;
  }

  const formatted = isMobile
    ? `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`
    : `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;

  return {
    digits,
    formatted,
    waNumber: `55${digits}`,
    isMobile,
    source
  };
}

/**
 * Unifica e desduplica uma lista de telefones preservando todas as fontes onde cada número apareceu.
 * Prioriza números celulares (WhatsApp) no topo da lista.
 *
 * @param {Array<{ raw: string, source: string }>} candidates
 * @returns {Array<{ digits: string, phone: string, waNumber: string, isMobile: boolean, source: string }>}
 */
function mergeAndDeduplicatePhones(candidates = []) {
  const mapByDigits = new Map();

  for (const item of candidates) {
    if (!item || !item.raw) continue;
    const norm = normalizeBrazilianPhone(item.raw, item.source);
    if (!norm) continue;

    const existing = mapByDigits.get(norm.digits);
    if (existing) {
      if (!existing.sources.includes(norm.source)) {
        existing.sources.push(norm.source);
        existing.source = existing.sources.join(' + ');
      }
    } else {
      mapByDigits.set(norm.digits, {
        digits: norm.digits,
        phone: norm.formatted,
        waNumber: norm.waNumber,
        isMobile: norm.isMobile,
        source: norm.source,
        sources: [norm.source]
      });
    }
  }

  const list = Array.from(mapByDigits.values()).map(({ sources, ...rest }) => rest);

  // Ordena priorizando celulares (isMobile: true) primeiro
  list.sort((a, b) => Number(b.isMobile) - Number(a.isMobile));
  return list;
}

/**
 * Valida e higieniza um endereço de e-mail extraído.
 * @param {string} rawEmail
 * @returns {string|null}
 */
function sanitizeEmail(rawEmail) {
  if (!rawEmail || typeof rawEmail !== 'string') return null;

  const clean = rawEmail.trim().toLowerCase().replace(/[.,;)>\]"']+$/, '');
  if (clean.length < 6 || clean.length > 85) return null;
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(clean)) return null;
  if (clean.includes('..')) return null;

  for (const ext of IGNORED_EMAIL_EXTENSIONS) {
    if (clean.endsWith(ext)) return null;
  }

  const domain = clean.split('@')[1];
  if (!domain || IGNORED_EMAIL_DOMAINS.has(domain)) return null;

  // Ignora placeholders comuns em templates
  if (
    clean.startsWith('seuemail@') ||
    clean.startsWith('nome@') ||
    clean.startsWith('email@') ||
    clean.startsWith('user@') ||
    clean.startsWith('usuario@') ||
    clean.startsWith('test@') ||
    clean.startsWith('teste@')
  ) {
    return null;
  }

  return clean;
}

/**
 * Extrai e-mails válidos de um conteúdo HTML, priorizando links `mailto:` e o domínio do próprio site.
 *
 * @param {string} htmlContent
 * @param {string} [websiteUri='']
 * @returns {string[]}
 */
function extractEmailsFromHtml(htmlContent, websiteUri = '') {
  if (!htmlContent || typeof htmlContent !== 'string') return [];

  let siteDomain = '';
  try {
    if (websiteUri) {
      const host = new URL(websiteUri.startsWith('http') ? websiteUri : `https://${websiteUri}`).hostname;
      siteDomain = host.replace(/^www\./i, '').toLowerCase();
    }
  } catch {
    // ignore
  }

  const mailtoCandidates = [];
  let match;
  MAILTO_REGEX.lastIndex = 0;
  while ((match = MAILTO_REGEX.exec(htmlContent)) !== null) {
    const clean = sanitizeEmail(match[1]);
    if (clean) mailtoCandidates.push(clean);
  }

  const rawMatches = htmlContent.match(EMAIL_REGEX) || [];
  const bodyCandidates = [];
  for (const raw of rawMatches) {
    const clean = sanitizeEmail(raw);
    if (clean) bodyCandidates.push(clean);
  }

  const uniqueEmails = Array.from(new Set([...mailtoCandidates, ...bodyCandidates]));

  // Ordena priorizando: 1) mailto, 2) domínio do próprio site
  uniqueEmails.sort((a, b) => {
    const aIsSite = siteDomain && a.endsWith(`@${siteDomain}`) ? 1 : 0;
    const bIsSite = siteDomain && b.endsWith(`@${siteDomain}`) ? 1 : 0;
    if (aIsSite !== bIsSite) return bIsSite - aIsSite;

    const aIsMailto = mailtoCandidates.includes(a) ? 1 : 0;
    const bIsMailto = mailtoCandidates.includes(b) ? 1 : 0;
    return bIsMailto - aIsMailto;
  });

  return uniqueEmails;
}

/**
 * Extrai números de telefone e WhatsApp de um conteúdo HTML.
 * @param {string} htmlContent
 * @returns {Array<{ raw: string, source: string }>}
 */
function extractPhonesFromHtml(htmlContent) {
  if (!htmlContent || typeof htmlContent !== 'string') return [];

  const found = [];
  let match;

  // 1. Links diretos de WhatsApp (wa.me / api.whatsapp.com)
  WA_LINK_REGEX.lastIndex = 0;
  while ((match = WA_LINK_REGEX.exec(htmlContent)) !== null) {
    found.push({ raw: match[1], source: 'Site (WhatsApp)' });
  }

  // 2. Links tel:
  TEL_LINK_REGEX.lastIndex = 0;
  while ((match = TEL_LINK_REGEX.exec(htmlContent)) !== null) {
    found.push({ raw: match[1], source: 'Site' });
  }

  // 3. Números formatados com (DDD) no corpo do HTML
  const textMatches = htmlContent.match(BR_PHONE_TEXT_REGEX) || [];
  for (const raw of textMatches) {
    found.push({ raw, source: 'Site' });
  }

  return found;
}

/**
 * Extrai o primeiro CNPJ matematicamente válido de um conteúdo HTML/texto.
 *
 * @param {string} htmlContent
 * @returns {string|null} CNPJ formatado (00.000.000/0001-00) ou null
 */
function extractCnpjFromHtml(htmlContent) {
  if (!htmlContent || typeof htmlContent !== 'string') {
    return null;
  }

  const matches = htmlContent.match(CNPJ_REGEX);
  if (!matches || matches.length === 0) {
    return null;
  }

  const punctuatedMatches = [];
  const plainMatches = [];

  for (const rawMatch of matches) {
    if (/[./-]/.test(rawMatch)) {
      punctuatedMatches.push(rawMatch);
    } else {
      plainMatches.push(rawMatch);
    }
  }

  const orderedCandidates = [...punctuatedMatches, ...plainMatches];

  for (const candidate of orderedCandidates) {
    if (isValidCnpj(candidate)) {
      return formatCnpj(candidate);
    }
  }

  return null;
}

/**
 * Constrói a lista ordenada de URLs candidatas para busca no website:
 * 1. URL principal (home informada pelo Google)
 * 2. Rota /contato
 * 3. Rota /politica-de-privacidade
 *
 * @param {string} websiteUri
 * @returns {string[]}
 */
function buildCandidateUrls(websiteUri) {
  if (!websiteUri || typeof websiteUri !== 'string') return [];

  let normalized = websiteUri.trim();
  if (!normalized) return [];

  if (!/^https?:\/\//i.test(normalized)) {
    normalized = `https://${normalized}`;
  }

  try {
    const parsedUrl = new URL(normalized);
    const origin = parsedUrl.origin;
    const candidates = new Set();

    candidates.add(parsedUrl.href);

    if (parsedUrl.pathname && parsedUrl.pathname !== '/') {
      candidates.add(`${origin}/`);
    }

    candidates.add(`${origin}/contato`);
    candidates.add(`${origin}/politica-de-privacidade`);

    return Array.from(candidates);
  } catch {
    return [];
  }
}

/**
 * Realiza uma requisição HTTP GET simples para obter o HTML da página.
 * @param {string} url
 * @returns {Promise<string|null>}
 */
async function fetchPageHtml(url) {
  try {
    const response = await axios.get(url, {
      timeout: SCRAPE_TIMEOUT_MS,
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      httpsAgent,
      maxRedirects: 4,
      maxContentLength: 2 * 1024 * 1024,
      responseType: 'text',
      validateStatus: (status) => status >= 200 && status < 400
    });

    return typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
  } catch {
    return null;
  }
}

/**
 * Extrai presença digital (Instagram, Link direto do iFood e Plataforma de Cardápio Digital)
 * a partir do HTML do site e/ou da própria URL cadastrada no Google.
 *
 * @param {string} htmlContent
 * @param {string} [websiteUri='']
 * @returns {{ instagramUrl: string|null, ifoodUrl: string|null, menuPlatform: string|null }}
 */
function extractDigitalPresenceFromHtml(htmlContent = '', websiteUri = '') {
  let instagramUrl = null;
  let ifoodUrl = null;
  let menuPlatform = null;

  const combinedText = `${websiteUri || ''} ${htmlContent || ''}`;

  // 1. Instagram
  const igRegex = /https?:\/\/(?:www\.)?instagram\.com\/([a-zA-Z0-9._]{2,30})\/?/gi;
  const igIgnored = new Set(['p', 'reel', 'reels', 'explore', 'accounts', 'stories', 'tv', 'share', 'about', 'legal']);
  let igMatch;
  while ((igMatch = igRegex.exec(combinedText)) !== null) {
    const handle = igMatch[1].replace(/\/$/, '');
    if (handle && !igIgnored.has(handle.toLowerCase())) {
      instagramUrl = `https://www.instagram.com/${handle}`;
      break;
    }
  }

  // 2. Link de loja iFood
  const ifoodRegex = /https?:\/\/(?:www\.)?ifood\.com\.br\/delivery\/[^\s"'<>)+]+/i;
  const ifoodMatch = combinedText.match(ifoodRegex);
  if (ifoodMatch) {
    ifoodUrl = ifoodMatch[0].replace(/['"<>)]+$/, '');
  }

  // 3. Plataformas conhecidas de Cardápio Digital / Link na Bio
  const platforms = [
    { name: 'Goomer', pattern: /goomer\.app/i },
    { name: 'Anota AI', pattern: /anota\.ai|pedido\.anota\.ai/i },
    { name: 'Cardápio Web', pattern: /cardapioweb\.com/i },
    { name: 'Saipos', pattern: /saipos\.com/i },
    { name: 'Neemo', pattern: /neemo\.com\.br|deliveryapp\.neemo/i },
    { name: 'Menudino', pattern: /menudino\.com/i },
    { name: 'OlaClick', pattern: /olaclick\.com|ola\.click/i },
    { name: 'Yooga', pattern: /yooga\.app|delivery\.yooga/i },
    { name: 'Linktree', pattern: /linktr\.ee/i },
    { name: 'Abrahão', pattern: /abrahao\.com\.br/i },
    { name: 'Pedir.to', pattern: /pedir\.to/i }
  ];

  for (const p of platforms) {
    if (p.pattern.test(combinedText)) {
      menuPlatform = p.name;
      break;
    }
  }

  return { instagramUrl, ifoodUrl, menuPlatform };
}

/**
 * Etapa A: Faz scraping leve no website do lead procurando simultaneamente:
 * - CNPJ válido
 * - E-mails de contato
 * - Telefones / WhatsApps adicionais
 * - Presença Digital (Instagram, iFood, Plataforma de Cardápio)
 *
 * @param {string} websiteUri
 * @param {Function} [pageFetcher=fetchPageHtml]
 * @returns {Promise<{ cnpj: string|null, sourceUrl: string|null, emails: string[], phones: Array<{ raw: string, source: string }>, instagramUrl: string|null, ifoodUrl: string|null, menuPlatform: string|null }>}
 */
async function scrapeCnpjFromWebsite(websiteUri, pageFetcher = fetchPageHtml) {
  const initialPresence = extractDigitalPresenceFromHtml('', websiteUri);
  const candidateUrls = buildCandidateUrls(websiteUri);
  if (candidateUrls.length === 0) {
    return {
      cnpj: null,
      sourceUrl: null,
      emails: [],
      phones: [],
      ...initialPresence
    };
  }

  let foundCnpj = null;
  let cnpjSourceUrl = null;
  const collectedEmails = new Set();
  const collectedPhones = [];
  let instagramUrl = initialPresence.instagramUrl;
  let ifoodUrl = initialPresence.ifoodUrl;
  let menuPlatform = initialPresence.menuPlatform;

  for (const url of candidateUrls) {
    try {
      const html = await pageFetcher(url);
      if (!html) continue;

      if (!foundCnpj) {
        const validCnpj = extractCnpjFromHtml(html);
        if (validCnpj) {
          foundCnpj = validCnpj;
          cnpjSourceUrl = url;
        }
      }

      const pageEmails = extractEmailsFromHtml(html, websiteUri);
      for (const em of pageEmails) {
        collectedEmails.add(em);
      }

      const pagePhones = extractPhonesFromHtml(html);
      collectedPhones.push(...pagePhones);

      const presence = extractDigitalPresenceFromHtml(html, url);
      if (!instagramUrl && presence.instagramUrl) instagramUrl = presence.instagramUrl;
      if (!ifoodUrl && presence.ifoodUrl) ifoodUrl = presence.ifoodUrl;
      if (!menuPlatform && presence.menuPlatform) menuPlatform = presence.menuPlatform;

      // Se já encontrou tanto o CNPJ quanto pelo menos um e-mail na home, não precisa varrer subpáginas
      if (foundCnpj && collectedEmails.size > 0) {
        break;
      }
    } catch {
      continue;
    }
  }

  return {
    cnpj: foundCnpj,
    sourceUrl: cnpjSourceUrl,
    emails: Array.from(collectedEmails),
    phones: collectedPhones,
    instagramUrl,
    ifoodUrl,
    menuPlatform
  };
}

/**
 * Formata nome de sócio em Title Case limpo (ex: "JOAO DA SILVA" -> "João da Silva")
 * @param {string} rawName
 * @returns {string|null}
 */
function formatPartnerName(rawName) {
  if (!rawName || typeof rawName !== 'string') return null;
  const cleaned = rawName.replace(/\s+/g, ' ').trim();
  if (cleaned.length < 3) return null;

  const lowerWords = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);
  return cleaned
    .toLowerCase()
    .split(' ')
    .map((word, idx) => {
      if (idx > 0 && lowerWords.has(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

/**
 * Consulta as APIs públicas gratuitas da Receita Federal (BrasilAPI + CNPJ.ws + ReceitaWS)
 * a partir de um CNPJ válido para obter:
 * - Todos os números de telefone cadastrados no CNPJ (ddd_telefone_1, ddd_telefone_2)
 * - E-mail cadastrado na Receita Federal
 * - Razão Social oficial da empresa
 * - Quadro de Sócios e Administradores (QSA)
 *
 * @param {string} cnpj
 * @returns {Promise<{ razaoSocial: string|null, socios: string[], emails: string[], phones: Array<{ raw: string, source: string }> }>}
 */
async function fetchPublicCnpjDetails(cnpj) {
  const digits = stripNonDigits(cnpj);
  if (digits.length !== 14) {
    return { razaoSocial: null, socios: [], emails: [], phones: [] };
  }

  let razaoSocial = null;
  const sociosSet = new Set();
  const emails = new Set();
  const phones = [];

  // 1. Consulta BrasilAPI (Rápida e gratuita)
  try {
    const res = await axios.get(`https://brasilapi.com.br/api/cnpj/v1/${digits}`, {
      timeout: 4000,
      headers: { 'User-Agent': DEFAULT_USER_AGENT }
    });
    const data = res.data;
    if (data) {
      if (data.razao_social) razaoSocial = String(data.razao_social).trim();
      const cleanEmail = sanitizeEmail(data.email);
      if (cleanEmail) emails.add(cleanEmail);

      if (data.ddd_telefone_1) {
        phones.push({ raw: String(data.ddd_telefone_1), source: 'CNPJ' });
      }
      if (data.ddd_telefone_2) {
        phones.push({ raw: String(data.ddd_telefone_2), source: 'CNPJ' });
      }

      if (Array.isArray(data.qsa)) {
        for (const s of data.qsa) {
          const formattedPartner = formatPartnerName(s?.nome_socio);
          if (formattedPartner) sociosSet.add(formattedPartner);
        }
      }
    }
  } catch {
    // Prossegue para próxima fonte
  }

  // 2. Consulta ReceitaWS (Complementar ou fallback caso falte telefone/e-mail/sócios)
  if (phones.length === 0 || emails.size === 0 || sociosSet.size === 0) {
    try {
      const res = await axios.get(`https://receitaws.com.br/v1/cnpj/${digits}`, {
        timeout: 4000,
        headers: { 'User-Agent': DEFAULT_USER_AGENT }
      });
      const data = res.data;
      if (data && data.status !== 'ERROR') {
        if (!razaoSocial && data.nome) razaoSocial = String(data.nome).trim();
        const cleanEmail = sanitizeEmail(data.email);
        if (cleanEmail) emails.add(cleanEmail);

        if (data.telefone) {
          const parts = String(data.telefone).split('/');
          for (const part of parts) {
            phones.push({ raw: part.trim(), source: 'CNPJ' });
          }
        }

        if (Array.isArray(data.qsa)) {
          for (const s of data.qsa) {
            const formattedPartner = formatPartnerName(s?.nome);
            if (formattedPartner) sociosSet.add(formattedPartner);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // 3. Consulta Pública CNPJ.ws (Fallback adicional se ainda não houver telefone)
  if (phones.length === 0 || sociosSet.size === 0) {
    try {
      const res = await axios.get(`https://publica.cnpj.ws/cnpj/${digits}`, {
        timeout: 4000,
        headers: { 'User-Agent': DEFAULT_USER_AGENT }
      });
      const data = res.data;
      if (data) {
        if (!razaoSocial && data.razao_social) razaoSocial = String(data.razao_social).trim();
        if (Array.isArray(data.socios)) {
          for (const s of data.socios) {
            const formattedPartner = formatPartnerName(s?.nome);
            if (formattedPartner) sociosSet.add(formattedPartner);
          }
        }
        const estab = data.estabelecimento;
        if (estab) {
          const cleanEmail = sanitizeEmail(estab.email);
          if (cleanEmail) emails.add(cleanEmail);

          if (estab.ddd1 && estab.telefone1) {
            phones.push({ raw: `${estab.ddd1}${estab.telefone1}`, source: 'CNPJ' });
          }
          if (estab.ddd2 && estab.telefone2) {
            phones.push({ raw: `${estab.ddd2}${estab.telefone2}`, source: 'CNPJ' });
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return {
    razaoSocial,
    socios: Array.from(sociosSet),
    emails: Array.from(emails),
    phones
  };
}

/**
 * Etapa B (Fallback Automático por Nome Fantasia + CEP/Endereço):
 * Quando o site não existe ou não exibe o CNPJ em texto, busca o CNPJ público do estabelecimento
 * cruzando o Nome Fantasia + CEP/Endereço e validando na Receita Federal (BrasilAPI) se o CEP ou Nome batem.
 */
async function fallbackLookupCnpjByBusinessData(leadContext) {
  try {
    if (!leadContext?.name) return null;

    // 1. Se houver API externa customizada configurada no .env
    const externalApiUrl = process.env.CNPJ_EXTERNAL_API_URL;
    const externalApiKey = process.env.CNPJ_EXTERNAL_API_KEY;
    if (externalApiUrl && externalApiKey) {
      try {
        const response = await axios.get(externalApiUrl, {
          params: { q: leadContext.name, address: leadContext.address || '' },
          headers: { Authorization: `Bearer ${externalApiKey}` },
          timeout: SCRAPE_TIMEOUT_MS
        });
        const candidateCnpj = response.data?.cnpj;
        if (candidateCnpj && isValidCnpj(candidateCnpj)) {
          return formatCnpj(candidateCnpj);
        }
      } catch {
        // prossegue para busca pública automática
      }
    }

    // 2. Extrai CEP, UF, Cidade e palavras-chave do nome do estabelecimento (qualquer estado/município do Brasil)
    const addressStr = String(leadContext.address || '');
    const cepMatch = addressStr.match(/\b(\d{5})-?(\d{3})\b/);
    const leadCepDigits = cepMatch ? `${cepMatch[1]}${cepMatch[2]}` : '';
    const leadCepFormatted = cepMatch ? `${cepMatch[1]}-${cepMatch[2]}` : '';

    // Extrai UF e Cidade do endereço formatado do Google (ex: "..., Belo Horizonte - MG, 30112-010, Brasil")
    const ufCityMatch = addressStr.match(/,\s*([^,-]+?)\s*-\s*([A-Z]{2})\b/);
    const leadCity = ufCityMatch ? ufCityMatch[1].trim() : '';
    const leadUf = ufCityMatch ? ufCityMatch[2].trim().toUpperCase() : '';
    const locationHint = [leadCity, leadUf].filter(Boolean).join(' ') || 'Brasil';

    // Limpa sufixos comuns (ex: "Cabana Burger (Pinheiros)" -> "Cabana Burger")
    const cleanName = String(leadContext.name)
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\|.*$/g, ' ')
      .replace(/[-–—].*$/g, ' ')
      .trim();

    const normalizeText = (str) =>
      String(str || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9\s]/g, ' ')
        .trim();

    const stopWords = new Set([
      'RESTAURANTE', 'HAMBURGUERIA', 'BURGER', 'BURGERS', 'PIZZARIA', 'PIZZA',
      'BAR', 'LANCHES', 'SANDWICHES', 'DELIVERY', 'SP', 'RJ', 'MG', 'PR', 'RS',
      'SC', 'BA', 'PE', 'CE', 'GO', 'DF', 'SAO', 'PAULO', 'RIO', 'JANEIRO',
      'PINHEIROS', 'ITAIM', 'MOEMA', 'VILA', 'JARDINS', 'LTDA', 'EIRELI', 'ME'
    ]);

    const nameTokens = normalizeText(cleanName)
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !stopWords.has(w));

    const searchQueries = [];
    if (leadCepFormatted) {
      searchQueries.push(`"${cleanName}" "${leadCepFormatted}" CNPJ`);
    }
    searchQueries.push(`"${cleanName}" CNPJ ${locationHint}`);

    const candidateCnpjs = [];
    const seenDigits = new Set();

    for (const q of searchQueries) {
      const searchUrls = [
        `https://br.search.yahoo.com/search?p=${encodeURIComponent(q)}`,
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`
      ];

      for (const sUrl of searchUrls) {
        const html = await fetchPageHtml(sUrl);
        if (!html) continue;

        const matches = html.match(CNPJ_REGEX) || [];
        for (const m of matches) {
          const d = stripNonDigits(m);
          if (d.length === 14 && !seenDigits.has(d) && isValidCnpj(d)) {
            seenDigits.add(d);
            candidateCnpjs.push(d);
          }
        }
        if (candidateCnpjs.length >= 4) break;
      }
      if (candidateCnpjs.length >= 4) break;
    }

    // 3. Valida os CNPJs candidatos na BrasilAPI para garantir que pertencem ao estabelecimento (mesmo CEP ou mesmo Nome na mesma UF)
    for (const digits of candidateCnpjs.slice(0, 4)) {
      try {
        const res = await axios.get(`https://brasilapi.com.br/api/cnpj/v1/${digits}`, {
          timeout: 3500,
          headers: { 'User-Agent': DEFAULT_USER_AGENT }
        });
        const data = res.data;
        if (!data) continue;

        const apiCep = stripNonDigits(String(data.cep || ''));
        const apiRazao = normalizeText(data.razao_social);
        const apiFantasia = normalizeText(data.nome_fantasia);

        // Critério 1: Mesmo CEP exato (altíssima precisão)
        if (leadCepDigits && apiCep && leadCepDigits === apiCep) {
          return formatCnpj(digits);
        }

        // Critério 2: Nome Fantasia ou Razão Social contém token principal do estabelecimento na mesma UF
        const ufMatches = !leadUf || !data.uf || String(data.uf).toUpperCase() === leadUf;
        if (nameTokens.length > 0 && ufMatches) {
          const matchesToken = nameTokens.some(
            (token) => apiFantasia.includes(token) || apiRazao.includes(token)
          );
          if (matchesToken) {
            return formatCnpj(digits);
          }
        }
      } catch {
        continue;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Enriquecimento completo de um único lead:
 * - CNPJ (Website Scraping + Validador Matemático + Fallback)
 * - E-mail (Website Scraping + Ficha Oficial do CNPJ na Receita Federal)
 * - Todos os Telefones vinculados ao CNPJ, Site e Google Maps (desduplicados e identificados)
 * - Razão Social oficial do CNPJ
 *
 * Nunca lança exceções para não interromper o pipeline de extração.
 *
 * @param {Object} lead
 * @param {Object} [options]
 * @param {Function} [options.pageFetcher]
 * @param {Function} [options.cnpjDetailsFetcher]
 * @returns {Promise<Object>}
 */
async function enrichLeadWithCnpj(lead, options = {}) {
  const leadIdentifier = lead?.name || lead?.id || 'Desconhecido';

  try {
    let foundCnpj = lead?.cnpj && isValidCnpj(lead.cnpj) ? formatCnpj(lead.cnpj) : null;
    let razaoSocial = lead?.razaoSocial || null;
    let socios = Array.isArray(lead?.socios) ? [...lead.socios] : [];
    let instagramUrl = lead?.instagramUrl || null;
    let ifoodUrl = lead?.ifoodUrl || null;
    let menuPlatform = lead?.menuPlatform || null;
    const allEmailCandidates = [];
    const allPhoneCandidates = [];

    // 1. Telefone original do Google Places
    if (lead?.phone) {
      allPhoneCandidates.push({ raw: lead.phone, source: 'Google' });
    }

    // 2. Etapa A: Website Scraping (CNPJ + E-mails + Telefones + Presença Digital do site)
    if (lead?.website && typeof lead.website === 'string' && lead.website.trim().length > 0) {
      const siteData = await scrapeCnpjFromWebsite(lead.website, options.pageFetcher);

      if (siteData.cnpj) {
        foundCnpj = siteData.cnpj;
        console.log(`[CNPJ Enrichment] Lead ${leadIdentifier}: CNPJ ${foundCnpj} encontrado via website`);
      }

      if (siteData.emails && siteData.emails.length > 0) {
        allEmailCandidates.push(...siteData.emails);
      }

      if (siteData.phones && siteData.phones.length > 0) {
        allPhoneCandidates.push(...siteData.phones);
      }

      if (siteData.instagramUrl) instagramUrl = siteData.instagramUrl;
      if (siteData.ifoodUrl) ifoodUrl = siteData.ifoodUrl;
      if (siteData.menuPlatform) menuPlatform = siteData.menuPlatform;
    }

    // 3. Etapa B: Fallback de CNPJ se não achou no site
    if (!foundCnpj) {
      const fallbackCnpj = await fallbackLookupCnpjByBusinessData({
        name: lead?.name,
        address: lead?.address
      });

      if (fallbackCnpj) {
        foundCnpj = fallbackCnpj;
        console.log(`[CNPJ Enrichment] Lead ${leadIdentifier}: CNPJ ${foundCnpj} encontrado via fallback API`);
      } else {
        console.log(`[CNPJ Enrichment] Lead ${leadIdentifier}: Nenhum CNPJ localizado`);
      }
    }

    // 4. Se temos um CNPJ válido, consulta os dados oficiais do CNPJ (Telefones 1 e 2 da Receita + E-mail + Razão Social + Sócios QSA)
    if (foundCnpj) {
      const detailsFetcher = options.cnpjDetailsFetcher || fetchPublicCnpjDetails;
      const cnpjDetails = await detailsFetcher(foundCnpj);

      if (cnpjDetails) {
        if (cnpjDetails.razaoSocial) {
          razaoSocial = cnpjDetails.razaoSocial;
        }
        if (Array.isArray(cnpjDetails.socios) && cnpjDetails.socios.length > 0) {
          socios = Array.from(new Set([...socios, ...cnpjDetails.socios]));
        }
        if (Array.isArray(cnpjDetails.emails) && cnpjDetails.emails.length > 0) {
          allEmailCandidates.push(...cnpjDetails.emails);
        }
        if (Array.isArray(cnpjDetails.phones) && cnpjDetails.phones.length > 0) {
          allPhoneCandidates.push(...cnpjDetails.phones);
        }
      }
    }

    // 5. Consolida E-mails únicos
    const uniqueEmails = Array.from(new Set(allEmailCandidates.filter(Boolean)));
    const primaryEmail = uniqueEmails.length > 0 ? uniqueEmails[0] : null;

    if (primaryEmail) {
      console.log(`[Lead Enrichment] Lead ${leadIdentifier}: E-mail ${primaryEmail} localizado`);
    }

    // 6. Consolida e desduplica todos os telefones (Google + CNPJ + Site)
    const allPhones = mergeAndDeduplicatePhones(allPhoneCandidates);

    if (allPhones.length > 1) {
      console.log(
        `[Lead Enrichment] Lead ${leadIdentifier}: ${allPhones.length} números únicos localizados (${allPhones
          .map((p) => `${p.phone} [${p.source}]`)
          .join(', ')})`
      );
    }

    // Define o telefone principal e o melhor número para WhatsApp (priorizando celular se houver)
    const bestMobile = allPhones.find((p) => p.isMobile);
    const primaryPhoneObj = bestMobile || allPhones[0] || null;

    const finalPhone = lead?.phone || primaryPhoneObj?.phone || '';
    const finalWaNumber = bestMobile?.waNumber || lead?.waNumber || primaryPhoneObj?.waNumber || '';

    return {
      ...lead,
      cnpj: foundCnpj || null,
      razaoSocial: razaoSocial || null,
      socios,
      instagramUrl: instagramUrl || null,
      ifoodUrl: ifoodUrl || null,
      menuPlatform: menuPlatform || null,
      email: primaryEmail,
      allEmails: uniqueEmails,
      phone: finalPhone,
      waNumber: finalWaNumber,
      allPhones
    };
  } catch (error) {
    console.warn(
      `[CNPJ Enrichment] Lead ${leadIdentifier}: Erro inesperado durante enriquecimento (${error.message}).`
    );
    return {
      ...lead,
      cnpj: null,
      razaoSocial: null,
      socios: [],
      instagramUrl: null,
      ifoodUrl: null,
      menuPlatform: null,
      email: null,
      allEmails: [],
      allPhones: lead?.phone ? mergeAndDeduplicatePhones([{ raw: lead.phone, source: 'Google' }]) : []
    };
  }
}

/**
 * Executa o enriquecimento de CNPJ, E-mail e Telefones para uma lista de leads com concorrência controlada.
 *
 * @param {Array<Object>} leads
 * @param {number} [concurrency=5]
 * @param {Object} [options]
 * @returns {Promise<Array<Object>>}
 */
async function enrichLeadsBatch(leads, concurrency = 5, options = {}) {
  if (!Array.isArray(leads) || leads.length === 0) {
    return [];
  }

  const results = new Array(leads.length);
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < leads.length) {
      const index = currentIndex++;
      const lead = leads[index];
      try {
        results[index] = await enrichLeadWithCnpj(lead, options);
      } catch {
        results[index] = {
          ...lead,
          cnpj: null,
          razaoSocial: null,
          socios: [],
          instagramUrl: null,
          ifoodUrl: null,
          menuPlatform: null,
          email: null,
          allEmails: [],
          allPhones: []
        };
      }
    }
  }

  const workerCount = Math.min(concurrency, leads.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.allSettled(workers);

  return results;
}

module.exports = {
  CNPJ_REGEX,
  stripNonDigits,
  formatCnpj,
  isValidCnpj,
  normalizeBrazilianPhone,
  mergeAndDeduplicatePhones,
  sanitizeEmail,
  extractEmailsFromHtml,
  extractPhonesFromHtml,
  extractDigitalPresenceFromHtml,
  extractCnpjFromHtml,
  buildCandidateUrls,
  scrapeCnpjFromWebsite,
  fetchPublicCnpjDetails,
  fallbackLookupCnpjByBusinessData,
  enrichLeadWithCnpj,
  enrichLeadsBatch
};
