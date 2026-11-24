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
    timeout: 7500,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: BASE_URL
    }
  });
  return res.data || '';
}

function parseFixturesHtml(html, fallbackWeek = null) {
  const $ = cheerio.load(html || '');
  const matches = [];
  const seen = new Set();

  let detectedWeek = fallbackWeek;
  const weekHeading = cleanText($('h1, h2, h3, .week-title, .active, select option[selected]').text());
  const weekMatch = weekHeading.match(/Pekan\s*(\d+)/i);
  if (weekMatch) {
    detectedWeek = parseInt(weekMatch[1], 10);
  }

  let currentDate = '';

  $('tr, .match-item, .fixture-item, .schedule-item, .card, li').each((_, el) => {
    const row = $(el);
    if (row.closest('header, nav, footer').length > 0) return;

    const rowText = cleanText(row.text());

    if (
      rowText.length < 45 &&
      /\d{1,2}\s+(?:Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember)\s+\d{4}/i.test(rowText) &&
      !row.find('a[href*="/result/detail/"], a[href*="/fixtures/detail/"]').length
    ) {
      currentDate = rowText;
      return;
    }

    const detailLink = row
      .find('a[href*="/result/detail/"], a[href*="/fixtures/detail/"], a[href*="/match/"]')
      .first();

    const imgs = row.find('img').filter((__, img) => {
      const src = $(img).attr('data-src') || $(img).attr('src') || '';
      return src.includes('/uploads/images/logo/') && !src.includes('competition-logo');
    });

    if (!detailLink.length && imgs.length < 2) return;
    if (row.find('tr, .match-item, .fixture-item').length > 1) return;

    const href = detailLink.attr('href') || '';
    const matchId = extractMatchId(href);
    const idParts = (matchId || '').split('/');
    const dateFromId =
      idParts.length >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(idParts[0]) ? idParts[0] : '';

    const teamTexts = [];
    row.find('td, span, p, div, h4, h5, strong, a').each((__, node) => {
      if ($(node).children().length === 0) {
        const t = cleanText($(node).text());
        if (
          t &&
          t.length >= 3 &&
          /[a-zA-Z]{3,}/.test(t) &&
          !/^(FT|HT|LIVE|VS|WIB|WITA|WIT|DETAIL|STATISTIK|PEKAN)$/i.test(t) &&
          !/^\d{1,2}[:.]\d{2}/.test(t) &&
          !/^(Senin|Selasa|Rabu|Kamis|Jumat|Sabtu|Minggu),/i.test(t) &&
          !teamTexts.includes(t)
        ) {
          teamTexts.push(t);
        }
      }
    });

    const homeName =
      teamTexts[0] || (idParts[1] ? idParts[1].replace(/_+/g, ' ').trim() : '');
    const awayName =
      teamTexts[1] || (idParts[2] ? idParts[2].replace(/_+/g, ' ').trim() : '');

    if (!homeName || !awayName || homeName === awayName) return;

    const uniqueKey = matchId || `${dateFromId || currentDate}-${homeName}-${awayName}`;
    if (seen.has(uniqueKey)) return;
    seen.add(uniqueKey);

    const homeLogo = imgs[0]
      ? normalizeUrl($(imgs[0]).attr('data-src') || $(imgs[0]).attr('src'))
      : null;
    const awayLogo = imgs[1]
      ? normalizeUrl($(imgs[1]).attr('data-src') || $(imgs[1]).attr('src'))
      : null;

    const scoreMatch = rowText.match(/\b(\d{1,2})\s*[-:]\s*(\d{1,2})\b/);
    const timeMatch = rowText.match(/\b(\d{1,2}:\d{2})\b/);

    let status = 'upcoming';
    let homeScore = null;
    let awayScore = null;

    if (/\bLIVE\b/i.test(rowText)) {
      status = 'live';
      if (scoreMatch) {
        homeScore = parseInt(scoreMatch[1], 10);
        awayScore = parseInt(scoreMatch[2], 10);
      }
    } else if (
      scoreMatch &&
      (href.includes('/result/detail/') || /\bFT\b/i.test(rowText) || !timeMatch)
    ) {
      status = 'finished';
      homeScore = parseInt(scoreMatch[1], 10);
      awayScore = parseInt(scoreMatch[2], 10);
    }

    matches.push({
      id: matchId || uniqueKey,
      week: detectedWeek,
      date: dateFromId || currentDate || null,
      time: timeMatch ? timeMatch[1] : null,
      status,
      home: {
        name: homeName,
        logo: homeLogo,
        score: homeScore
      },
      away: {
        name: awayName,
        logo: awayLogo,
        score: awayScore
      },
      detail_url: href ? normalizeUrl(href) : null
    });
  });

  return { matches, detectedWeek };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { week, status } = req.query || {};

    if (week) {
      const weekNum = parseInt(week, 10);
      const html = await fetchHtml(`/fixtures/index/${COMPETITION}/${weekNum}/0`);
      const parsed = parseFixturesHtml(html, weekNum);
      const filtered = status
        ? parsed.matches.filter((m) => m.status === String(status).toLowerCase())
        : parsed.matches;

      return res.status(200).json({
        success: true,
        source: 'ileague.id',
        competition: COMPETITION,
        week: parsed.detectedWeek || weekNum,
        updated_at: new Date().toISOString(),
        total: filtered.length,
        data: filtered
      });
    }

    // Ambil pekan aktif dan pekan 10 secara paralel agar cepat dan tidak timeout
    const [currentResult, prevResult] = await Promise.allSettled([
      fetchHtml(`/fixtures/index/${COMPETITION}`),
      fetchHtml(`/fixtures/index/${COMPETITION}/10/0`)
    ]);

    const currentParsed =
      currentResult.status === 'fulfilled'
        ? parseFixturesHtml(currentResult.value)
        : { matches: [], detectedWeek: 11 };

    const prevParsed =
      prevResult.status === 'fulfilled'
        ? parseFixturesHtml(prevResult.value, 10)
        : { matches: [], detectedWeek: 10 };

    const mergedMap = new Map();
    [...prevParsed.matches, ...currentParsed.matches].forEach((m) => {
      if (m && m.id) mergedMap.set(m.id, m);
    });

    const allMatches = Array.from(mergedMap.values());
    const filtered = status
      ? allMatches.filter((m) => m.status === String(status).toLowerCase())
      : allMatches;

    return res.status(200).json({
      success: true,
      source: 'ileague.id',
      competition: COMPETITION,
      week: currentParsed.detectedWeek || 11,
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
