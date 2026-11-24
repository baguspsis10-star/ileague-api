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

function parseScoreAndStatus(cardText, href) {
  const timeMatch = cardText.match(/\b(\d{1,2}:\d{2})\b/);

  // Hapus format tanggal (2026-11-26) dan jam (15:30) sebelum mencari skor agar tidak muncul angka puluhan
  const sanitizedText = cardText
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ');

  const scoreMatch = sanitizedText.match(/\b(\d{1,2})\s*-\s*(\d{1,2})\b/);
  const isResultUrl = href.includes('/result/');
  const isFixtureUrl = href.includes('/fixtures/');

  if (/\bLIVE\b/i.test(sanitizedText)) {
    return {
      status: 'live',
      time: timeMatch ? timeMatch[1] : null,
      homeScore: scoreMatch ? parseInt(scoreMatch[1], 10) : 0,
      awayScore: scoreMatch ? parseInt(scoreMatch[2], 10) : 0
    };
  }

  if (isResultUrl || (scoreMatch && !isFixtureUrl && !timeMatch)) {
    return {
      status: 'finished',
      time: timeMatch ? timeMatch[1] : null,
      homeScore: scoreMatch ? parseInt(scoreMatch[1], 10) : null,
      awayScore: scoreMatch ? parseInt(scoreMatch[2], 10) : null
    };
  }

  return {
    status: 'upcoming',
    time: timeMatch ? timeMatch[1] : null,
    homeScore: null,
    awayScore: null
  };
}

function parseFixturesHtml(html, weekNum) {
  const $ = cheerio.load(html || '');
  const matches = [];
  const seen = new Set();

  // 1. Ekstraksi berbasis tautan detail pertandingan (/result/detail/ atau /fixtures/detail/)
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

    const parsedState = parseScoreAndStatus(cardText, href);

    matches.push({
      id: matchId,
      week: weekNum,
      date: dateStr,
      time: parsedState.time,
      status: parsedState.status,
      home: {
        name: homeName,
        logo: logos[0] || null,
        score: parsedState.homeScore
      },
      away: {
        name: awayName,
        logo: logos[1] || null,
        score: parsedState.awayScore
      },
      detail_url: normalizeUrl(href)
    });
  });

  // 2. Fallback untuk baris jadwal mendatang yang belum memiliki tautan detail
  let currentDate = '';
  $('div, li, tr').each((_, el) => {
    const row = $(el);
    if (row.closest('header, nav, footer').length > 0) return;

    const rowText = cleanText(row.text());
    if (!rowText) return;

    if (
      rowText.length < 50 &&
      /\d{1,2}\s+(?:Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember)\s+\d{4}/i.test(
        rowText
      ) &&
      row.find('img').length === 0
    ) {
      currentDate = rowText;
      return;
    }

    const logos = [];
    row.find('img').each((__, img) => {
      const src = normalizeUrl($(img).attr('data-src') || $(img).attr('src'));
      if (src && src.includes('/uploads/images/logo/') && !src.includes('competition-logo')) {
        if (!logos.includes(src)) logos.push(src);
      }
    });

    if (logos.length !== 2 || rowText.length > 220) return;

    const teamTexts = [];
    row.find('span, p, div, h4, h5, strong, a, td').each((__, node) => {
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

    if (teamTexts.length < 2) return;
    const homeName = teamTexts[0];
    const awayName = teamTexts[1];
    if (homeName === awayName) return;

    // Cek apakah pertandingan ini sudah tertangkap di langkah 1
    const alreadyExists = matches.some(
      (m) =>
        m.week === weekNum &&
        m.home.name.toUpperCase() === homeName.toUpperCase() &&
        m.away.name.toUpperCase() === awayName.toUpperCase()
    );
    if (alreadyExists) return;

    const fallbackId = `${currentDate || `week-${weekNum}`}/${homeName.replace(/\s+/g, '_')}/${awayName.replace(/\s+/g, '_')}`;
    if (seen.has(fallbackId)) return;
    seen.add(fallbackId);

    const parsedState = parseScoreAndStatus(rowText, '');

    matches.push({
      id: fallbackId,
      week: weekNum,
      date: currentDate || null,
      time: parsedState.time,
      status: parsedState.status,
      home: {
        name: homeName,
        logo: logos[0] || null,
        score: parsedState.homeScore
      },
      away: {
        name: awayName,
        logo: logos[1] || null,
        score: parsedState.awayScore
      },
      detail_url: null
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
      const html11 = await fetchHtml(`/fixtures/index/${COMPETITION}/11/0`);
      const $ = cheerio.load(html11);
      const sampleCards = [];
      $(`a[href*="/${COMPETITION}/"]`).each((_, el) => {
        const href = $(el).attr('href') || '';
        if (!href.includes('/index/') && sampleCards.length < 10) {
          sampleCards.push({
            href,
            cardText: cleanText(findMatchCard($, el).text())
          });
        }
      });
      return res.status(200).json({
        success: true,
        sampleCards,
        bodySnippet: cleanText($('main, .content, body').first().text()).slice(0, 1200)
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
