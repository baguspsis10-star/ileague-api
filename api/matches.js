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
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: BASE_URL
    }
  });
  return res.data || '';
}

function parseFixturesHtml(html, weekNum) {
  const $ = cheerio.load(html || '');
  const matches = [];
  const seen = new Set();
  let currentDate = '';

  // Deteksi baris jadwal dari tabel maupun kartu div
  $('table tr, .fixture-item, .match-item, .schedule-item, .list-group-item, .card-body .row').each(
    (_, el) => {
      const row = $(el);
      if (row.closest('header, nav, footer').length > 0) return;

      const rowText = cleanText(row.text());
      if (!rowText) return;

      // Tangkap header tanggal (contoh: "Jumat, 20 November 2026")
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

      // Cari logo klub di dalam baris
      const logos = [];
      row.find('img').each((__, img) => {
        const src = normalizeUrl($(img).attr('data-src') || $(img).attr('src'));
        if (src && src.includes('/uploads/images/logo/') && !src.includes('competition-logo')) {
          logos.push(src);
        }
      });

      // Cari link detail pertandingan
      const detailLink = row
        .find('a[href*="/detail/"], a[href*="/single/"], a[href*="/result/"], a[href*="/fixtures/"]')
        .filter((__, a) => {
          const h = $(a).attr('href') || '';
          return !h.includes('/fixtures/index/') && !h.includes('/clubs/');
        })
        .first();

      const href = detailLink.attr('href') || '';
      if (logos.length < 2 && !href) return;

      // Hindari kontainer pembungkus luar yang membungkus banyak pertandingan
      if (row.find('img[src*="/uploads/images/logo/"]').length > 3) return;

      const matchId = extractMatchId(href);
      const idParts = (matchId || '').split('/');
      const dateFromId =
        idParts.length >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(idParts[0]) ? idParts[0] : '';

      // Ekstrak nama klub dari teks sel atau slug URL
      const texts = [];
      row.find('td, span, p, div, h4, h5, strong, a').each((__, node) => {
        if ($(node).children().length === 0) {
          const t = cleanText($(node).text());
          if (
            t &&
            t.length >= 3 &&
            /[a-zA-Z]{3,}/.test(t) &&
            !/^(FT|HT|LIVE|VS|WIB|WITA|WIT|DETAIL|STATISTIK|PEKAN|LAPORAN)$/i.test(t) &&
            !/^\d{1,2}[:.]\d{2}/.test(t) &&
            !/^(Senin|Selasa|Rabu|Kamis|Jumat|Sabtu|Minggu),/i.test(t) &&
            !texts.includes(t)
          ) {
            texts.push(t);
          }
        }
      });

      const homeName =
        texts[0] || (idParts[1] ? idParts[1].replace(/_+/g, ' ').trim() : '');
      const awayName =
        texts[1] || (idParts[2] ? idParts[2].replace(/_+/g, ' ').trim() : '');

      if (!homeName || !awayName || homeName === awayName) return;

      const finalId =
        matchId ||
        `${dateFromId || currentDate || `w${weekNum}`}/${homeName.replace(/\s+/g, '_')}/${awayName.replace(/\s+/g, '_')}`;

      if (seen.has(finalId)) return;
      seen.add(finalId);

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
        (href.includes('/result/') || /\bFT\b/i.test(rowText) || !timeMatch)
      ) {
        status = 'finished';
        homeScore = parseInt(scoreMatch[1], 10);
        awayScore = parseInt(scoreMatch[2], 10);
      }

      matches.push({
        id: finalId,
        week: weekNum,
        date: dateFromId || currentDate || null,
        time: timeMatch ? timeMatch[1] : null,
        status,
        home: {
          name: homeName,
          logo: logos[0] || null,
          score: homeScore
        },
        away: {
          name: awayName,
          logo: logos[1] || null,
          score: awayScore
        },
        detail_url: href ? normalizeUrl(href) : null
      });
    }
  );

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
      const links = [];
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (href.includes('BRI_SUPER_LEAGUE') && links.length < 30) {
          links.push({ href, text: cleanText($(el).text()) });
        }
      });
      return res.status(200).json({
        success: true,
        tables: $('table').length,
        links,
        snippet: cleanText($('main, .content, body').first().text()).slice(0, 1200)
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

    // Ambil Pekan 10 (laga selesai) dan Pekan 11 (jadwal berjalan) secara paralel
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
