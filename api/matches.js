const cheerio = require('cheerio');
const { httpClient } = require('../lib/httpClient');
const { normalizeUrl, cleanText, handleCors, extractMatchId } = require('../lib/helpers');

async function fetchBestScheduleHtml() {
  const candidatePaths = [
    '/jadwal-pertandingan',
    '/jadwal',
    '/pertandingan',
    '/schedule',
    '/matches',
    '/fixtures',
    '/'
  ];

  // Cek halaman utama terlebih dahulu untuk menemukan link jadwal asli
  let homeHtml = '';
  try {
    const homeRes = await httpClient.get('/');
    homeHtml = homeRes.data;
    const $home = cheerio.load(homeHtml);

    $home('a[href]').each((_, el) => {
      const href = ($home(el).attr('href') || '').trim();
      const text = cleanText($home(el).text()).toLowerCase();
      if (
        (text.includes('jadwal') || text.includes('schedule') || text.includes('pertandingan') || text.includes('match')) &&
        href.startsWith('/') &&
        !candidatePaths.includes(href)
      ) {
        candidatePaths.unshift(href);
      }
    });
  } catch (_) {}

  for (const path of candidatePaths) {
    try {
      const res = path === '/' && homeHtml ? { data: homeHtml } : await httpClient.get(path);
      if (res.data && typeof res.data === 'string' && res.data.length > 500) {
        return { html: res.data, usedPath: path };
      }
    } catch (_) {}
  }

  return { html: homeHtml, usedPath: '/' };
}

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    const { status: filterStatus, week, debug } = req.query;
    const { html, usedPath } = await fetchBestScheduleHtml();
    const $ = cheerio.load(html || '');

    // Mode debug untuk melihat struktur HTML & link asli ileague.id
    if (debug === '1') {
      const links = [];
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        const text = cleanText($(el).text());
        if (href && text && links.length < 40) links.push({ text, href });
      });

      const sampleClasses = new Set();
      $('[class]').each((_, el) => {
        const cls = ($(el).attr('class') || '').split(/\s+/);
        cls.forEach((c) => {
          if (/match|jadwal|score|klub|club|team|fixture|game|vs/i.test(c)) {
            sampleClasses.add(c);
          }
        });
      });

      return res.status(200).json({
        success: true,
        usedPath,
        title: cleanText($('title').text()),
        htmlLength: (html || '').length,
        matchedClasses: Array.from(sampleClasses).slice(0, 50),
        links,
        snippet: cleanText($('body').text()).slice(0, 800)
      });
    }

    const matches = [];
    const seen = new Set();

    // 1. Parsing berbasis container umum maupun elemen yang mengandung "vs" / skor
    const selectors = [
      '.match-item',
      '.schedule-item',
      '.card-match',
      '.fixture-row',
      '.match-card',
      '.game-item',
      'tr',
      'li',
      'a[href*="match"]',
      'a[href*="pertandingan"]'
    ];

    $(selectors.join(', ')).each((i, el) => {
      const card = $(el);
      const imgs = card.find('img');
      if (imgs.length < 2) return;

      const fullText = cleanText(card.text());
      if (fullText.length < 5 || fullText.length > 350) return;

      const detailLink =
        card.is('a') ? card.attr('href') : card.find('a[href]').first().attr('href');
      const matchId = card.attr('data-id') || extractMatchId(detailLink) || `match-${i + 1}`;

      // Ambil nama tim dari elemen teks atau atribut alt gambar logo
      const textCandidates = [];
      card.find('span, p, div, h3, h4, h5, td').each((_, node) => {
        if ($(node).children().length === 0) {
          const t = cleanText($(node).text());
          if (
            t &&
            t.length >= 3 &&
            t.length <= 40 &&
            !/^\d+([:-]\d+)?$/.test(t) &&
            !/^(vs|ft|ht|live|wib|wita|wit)$/i.test(t) &&
            !/\d{1,2}\s+(jan|feb|mar|apr|mei|jun|jul|agu|sep|okt|nov|des)/i.test(t)
          ) {
            textCandidates.push(t);
          }
        }
      });

      const homeName = textCandidates[0] || cleanText($(imgs[0]).attr('alt'));
      const awayName = textCandidates[1] || cleanText($(imgs[1]).attr('alt'));

      if (!homeName || !awayName || homeName === awayName) return;

      const key = `${homeName}-${awayName}-${matchId}`;
      if (seen.has(key)) return;
      seen.add(key);

      const homeLogo = normalizeUrl($(imgs[0]).attr('data-src') || $(imgs[0]).attr('src'));
      const awayLogo = normalizeUrl($(imgs[1]).attr('data-src') || $(imgs[1]).attr('src'));

      const scoreMatch = fullText.match(/\b(\d{1,2})\s*[-:]\s*(\d{1,2})\b/);
      const timeMatch = fullText.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/);
      const isLive = /\b(LIVE|HT|BERLANGSUNG|\d{1,3}')\b/i.test(fullText);
      const isFinished = /\b(FT|SELESAI|FULL TIME)\b/i.test(fullText);

      let status = 'UPCOMING';
      if (isLive) status = 'LIVE';
      else if (isFinished || (scoreMatch && !timeMatch)) status = 'FINISHED';

      matches.push({
        id: matchId,
        status,
        matchweek: week ? `Pekan ${week}` : null,
        time: timeMatch ? `${timeMatch[1]}:${timeMatch[2]}` : null,
        raw_text: fullText,
        home: {
          name: homeName,
          logo: homeLogo,
          score: scoreMatch && status !== 'UPCOMING' ? parseInt(scoreMatch[1], 10) : null
        },
        away: {
          name: awayName,
          logo: awayLogo,
          score: scoreMatch && status !== 'UPCOMING' ? parseInt(scoreMatch[2], 10) : null
        },
        detail_url: detailLink ? normalizeUrl(detailLink) : null
      });
    });

    const filtered = filterStatus
      ? matches.filter((m) => m.status.toLowerCase() === filterStatus.toLowerCase())
      : matches;

    res.status(200).json({
      success: true,
      source: 'ileague.id',
      path_used: usedPath,
      updated_at: new Date().toISOString(),
      total: filtered.length,
      data: filtered
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil data pertandingan dari ileague.id',
      error: error.message
    });
  }
};
