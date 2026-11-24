const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://ileague.id';
const COMPETITION = 'BRI_SUPER_LEAGUE_2026-27';

function cleanText(str) {
  return String(str || '').replace(/\s+/g, ' ').trim();
}

function normalizeUrl(url) {
  if (!url) return null;
  const trimmed = String(url).trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  return `${BASE_URL}${trimmed.startsWith('/') ? '' : '/'}${trimmed}`;
}

function getTodayJakartaISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function extractMatchId(href) {
  if (!href) return null;
  const cleanHref = String(href).split('#')[0].split('?')[0];
  const idx = cleanHref.indexOf(`${COMPETITION}/`);
  if (idx !== -1) {
    const rest = cleanHref.slice(idx + COMPETITION.length + 1).replace(/^\/+|\/+$/g, '');
    if (rest.split('/').length >= 3) return rest;
  }
  return null;
}

async function fetchHtml(path) {
  const res = await axios.get(`${BASE_URL}${path}`, {
    timeout: 8000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: BASE_URL
    }
  });
  return res.data || '';
}

function findMatchCard($, el) {
  let card = $(el);
  for (let i = 0; i < 6; i++) {
    const parent = card.parent();
    if (!parent.length || parent.is('body, main, section')) break;

    const uniqueIds = new Set();
    parent.find(`a[href*="/${COMPETITION}/"]`).each((__, a) => {
      const mId = extractMatchId($(a).attr('href'));
      if (mId) uniqueIds.add(mId);
    });

    const logoCount = parent
      .find('img[src*="/uploads/images/logo/"]')
      .filter((__, img) => !($(img).attr('src') || '').includes('competition-logo')).length;

    if (uniqueIds.size > 1 || logoCount > 2) break;
    card = parent;
  }
  return card;
}

function extractScoresFromCard($, card, cardText, href, dateStr, todayIso) {
  const timeMatch = cardText.match(/\b(\d{1,2}:\d{2})\b/);
  const isLive = /\bLIVE\b/i.test(cardText);
  const isPastDate = Boolean(dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && dateStr < todayIso);
  const isFutureDate = Boolean(dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && dateStr > todayIso);

  // Jika tanggal pertandingan di masa depan dan tidak LIVE, pasti upcoming
  if (isFutureDate && !isLive) {
    return {
      status: 'upcoming',
      time: timeMatch ? timeMatch[1] : null,
      homeScore: null,
      awayScore: null
    };
  }

  // Bersihkan tanggal dan jam kick-off sebelum mencari angka skor
  const sanitizedText = cardText
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ');

  let homeScore = null;
  let awayScore = null;

  // Cara 1: Skor tergabung dalam satu teks (contoh: "1 - 0" atau "2 : 2")
  const combinedMatch = sanitizedText.match(/\b(\d{1,2})\s*[-:]\s*(\d{1,2})\b/);
  if (combinedMatch) {
    homeScore = parseInt(combinedMatch[1], 10);
    awayScore = parseInt(combinedMatch[2], 10);
  }

  // Cara 2: Skor berada di dua elemen HTML terpisah (contoh: <span>1</span> dan <span>0</span>)
  if (homeScore === null || awayScore === null) {
    const standaloneNums = [];
    card.find('span, div, p, strong, b, td, h3, h4, h5').each((_, node) => {
      if ($(node).children().length > 0) return;
      const t = cleanText($(node).text());
      if (/^\d{1,2}$/.test(t)) {
        const val = parseInt(t, 10);
        if (val >= 0 && val <= 15) {
          standaloneNums.push(val);
        }
      }
    });

    if (standaloneNums.length >= 2) {
      homeScore = standaloneNums[0];
      awayScore = standaloneNums[1];
    }
  }

  if (isLive) {
    return {
      status: 'live',
      time: timeMatch ? timeMatch[1] : null,
      homeScore: homeScore !== null ? homeScore : 0,
      awayScore: awayScore !== null ? awayScore : 0
    };
  }

  if (href.includes('/result/') || isPastDate || (homeScore !== null && awayScore !== null && !timeMatch)) {
    return {
      status: 'finished',
      time: timeMatch ? timeMatch[1] : null,
      homeScore,
      awayScore
    };
  }

  return {
    status: 'upcoming',
    time: timeMatch ? timeMatch[1] : null,
    homeScore: null,
    awayScore: null
  };
}

function parseFixturesHtml(html, weekNum, todayIso) {
  const $ = cheerio.load(html || '');
  const matches = [];
  const seen = new Set();

  $(`a[href*="/${COMPETITION}/"]`).each((_, el) => {
    const href = $(el).attr('href') || '';
    if (href.includes('/index/') || href.includes('/clubs/')) return;

    const matchId = extractMatchId(href);
    if (!matchId || seen.has(matchId)) return;

    const parts = matchId.split('/');
    if (parts.length < 3) return;
    seen.add(matchId);

    const dateStr = parts[0];
    const homeName = parts[1].replace(/_+/g, ' ').trim();
    const awayName = parts[2].replace(/_+/g, ' ').trim();

    const card = findMatchCard($, el);
    const cardText = cleanText(card.text());

    const logos = [];
    card.find('img').each((__, img) => {
      const src = normalizeUrl($(img).attr('data-src') || $(img).attr('src'));
      if (src && src.includes('/uploads/images/logo/') && !src.includes('competition-logo')) {
        if (!logos.includes(src)) logos.push(src);
      }
    });

    const parsed = extractScoresFromCard($, card, cardText, href, dateStr, todayIso);

    matches.push({
      id: matchId,
      week: weekNum,
      date: dateStr,
      time: parsed.time,
      status: parsed.status,
      home: {
        name: homeName,
        logo: logos[0] || null,
        score: parsed.homeScore
      },
      away: {
        name: awayName,
        logo: logos[1] || null,
        score: parsed.awayScore
      },
      detail_url: normalizeUrl(href)
    });
  });

  return matches;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { week, status } = req.query || {};
    const todayIso = getTodayJakartaISO();

    if (week) {
      const weekNum = parseInt(week, 10);
      const html = await fetchHtml(`/fixtures/index/${COMPETITION}/${weekNum}/0`);
      const list = parseFixturesHtml(html, weekNum, todayIso);
      const filtered = status
        ? list.filter((m) => m.status === String(status).toLowerCase())
        : list;

      return res.status(200).json({
        success: true,
        source: 'ileague.id',
        competition: COMPETITION,
        week: weekNum,
        updated_at: new Date().toISOString(),
        total: filtered.length,
        data: filtered
      });
    }

    const [res10, res11] = await Promise.allSettled([
      fetchHtml(`/fixtures/index/${COMPETITION}/10/0`),
      fetchHtml(`/fixtures/index/${COMPETITION}/11/0`)
    ]);

    const matches10 =
      res10.status === 'fulfilled' ? parseFixturesHtml(res10.value, 10, todayIso) : [];
    const matches11 =
      res11.status === 'fulfilled' ? parseFixturesHtml(res11.value, 11, todayIso) : [];

    const merged = [...matches10, ...matches11];
    const filtered = status
      ? merged.filter((m) => m.status === String(status).toLowerCase())
      : merged;

    return res.status(200).json({
      success: true,
      source: 'ileague.id',
      competition: COMPETITION,
      week: 11,
      updated_at: new Date().toISOString(),
      total: filtered.length,
      data: filtered
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal mengambil jadwal pertandingan dari ileague.id',
      error: error.message
    });
  }
};
