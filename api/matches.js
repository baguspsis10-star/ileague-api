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

function extractMatchId(href) {
  if (!href) return null;
  const cleanHref = String(href).split('#')[0].split('?')[0];
  const idx = cleanHref.indexOf(`${COMPETITION}/`);
  if (idx !== -1) {
    return cleanHref.slice(idx + COMPETITION.length + 1).replace(/^\/+|\/+$/g, '');
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

function findMatchCard($, linkEl) {
  let card = $(linkEl);
  for (let i = 0; i < 6; i++) {
    const parent = card.parent();
    if (!parent.length || parent.is('body, main, section')) break;
    // Berhenti sebelum naik ke kontainer besar yang memuat lebih dari 1 pertandingan
    const matchLinksInside = parent.find(`a[href*="/${COMPETITION}/202"]`).length;
    if (matchLinksInside > 1) break;
    card = parent;
  }
  return card;
}

function parseFixturesHtml(html, weekNum) {
  const $ = cheerio.load(html || '');
  const matches = [];
  const seen = new Set();

  $(`a[href*="/${COMPETITION}/202"]`).each((_, el) => {
    const href = $(el).attr('href') || '';
    const matchId = extractMatchId(href);
    if (!matchId || seen.has(matchId)) return;

    const parts = matchId.split('/');
    if (parts.length < 3) return;
    seen.add(matchId);

    const dateStr = parts[0];
    const homeFromSlug = parts[1].replace(/_+/g, ' ').trim();
    const awayFromSlug = parts[2].replace(/_+/g, ' ').trim();

    const card = findMatchCard($, el);
    const cardText = cleanText(card.text());

    // Ambil logo klub di dalam kartu pertandingan
    const logos = [];
    card.find('img').each((__, img) => {
      const src = normalizeUrl($(img).attr('data-src') || $(img).attr('src'));
      if (src && src.includes('/uploads/images/logo/') && !src.includes('competition-logo')) {
        if (!logos.includes(src)) logos.push(src);
      }
    });

    // Ambil jam kick-off dan skor
    const timeMatch = cardText.match(/\b(\d{1,2}:\d{2})\b/);
    const scoreMatch = cardText.match(/\b(\d{1,2})\s*[-:]\s*(\d{1,2})\b/);

    let status = 'upcoming';
    let homeScore = null;
    let awayScore = null;

    if (/\bLIVE\b/i.test(cardText)) {
      status = 'live';
      if (scoreMatch) {
        homeScore = parseInt(scoreMatch[1], 10);
        awayScore = parseInt(scoreMatch[2], 10);
      }
    } else if (
      scoreMatch &&
      (href.includes('/result/') || /\bFT\b/i.test(cardText) || !timeMatch)
    ) {
      status = 'finished';
      homeScore = parseInt(scoreMatch[1], 10);
      awayScore = parseInt(scoreMatch[2], 10);
    }

    matches.push({
      id: matchId,
      week: weekNum,
      date: dateStr,
      time: timeMatch ? timeMatch[1] : null,
      status,
      home: {
        name: homeFromSlug,
        logo: logos[0] || null,
        score: homeScore
      },
      away: {
        name: awayFromSlug,
        logo: logos[1] || null,
        score: awayScore
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
    const { week, status, debug } = req.query || {};

    if (debug === '1') {
      const html = await fetchHtml(`/fixtures/index/${COMPETITION}/10/0`);
      const $ = cheerio.load(html);
      const matchLinks = [];
      $(`a[href*="/${COMPETITION}/202"]`).each((_, el) => {
        matchLinks.push({
          href: $(el).attr('href'),
          text: cleanText($(el).text())
        });
      });
      return res.status(200).json({
        success: true,
        totalMatchLinks: matchLinks.length,
        matchLinks: matchLinks.slice(0, 15)
      });
    }

    if (week) {
      const weekNum = parseInt(week, 10);
      const html = await fetchHtml(`/fixtures/index/${COMPETITION}/${weekNum}/0`);
      const list = parseFixturesHtml(html, weekNum);
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

    // Ambil Pekan 10 (laga selesai) dan Pekan 11 (jadwal aktif) secara paralel
    const [res10, res11] = await Promise.allSettled([
      fetchHtml(`/fixtures/index/${COMPETITION}/10/0`),
      fetchHtml(`/fixtures/index/${COMPETITION}/11/0`)
    ]);

    const matches10 = res10.status === 'fulfilled' ? parseFixturesHtml(res10.value, 10) : [];
    const matches11 = res11.status === 'fulfilled' ? parseFixturesHtml(res11.value, 11) : [];

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
