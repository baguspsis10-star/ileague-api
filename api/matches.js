const cheerio = require('cheerio');
const { httpClient } = require('../lib/httpClient');
const { normalizeUrl, cleanText, handleCors, extractMatchId } = require('../lib/helpers');

const COMPETITION = 'BRI_SUPER_LEAGUE_2026-27';

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    const { status: filterStatus, week, debug } = req.query;

    // Gunakan endpoint jadwal asli ileague.id
    const targetPath = week
      ? `/fixtures/index/${COMPETITION}/${encodeURIComponent(week)}/0`
      : `/fixtures`;

    const response = await httpClient.get(targetPath);
    const html = response.data || '';
    const $ = cheerio.load(html);

    // Jika debug=1, tampilkan potret HTML area jadwal asli agar selector bisa dikunci 100%
    if (debug === '1') {
      const matchLinks = [];
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (/match|fixture|detail|vs/i.test(href) && !href.includes('/fixtures/index/')) {
          matchLinks.push({
            href,
            text: cleanText($(el).text()).slice(0, 120),
            parentClass: $(el).parent().attr('class') || ''
          });
        }
      });

      const pickerHtml = $('.fixtures-week-picker').parent().html() || '';
      return res.status(200).json({
        success: true,
        targetPath,
        matchLinksSample: matchLinks.slice(0, 15),
        containerHtmlSample: pickerHtml.slice(0, 3500)
      });
    }

    const matches = [];
    const seen = new Set();

    // Cari setiap blok/baris pertandingan yang memuat minimal 2 logo klub (bukan bendera bahasa)
    $('a[href*="/match"], a[href*="/detail"], .match-list > div, .fixture-item, .card, tr, li').each((i, el) => {
      const card = $(el);

      // Abaikan elemen navigasi/header/footer
      if (card.closest('header, nav, footer').length > 0) return;

      const imgs = card.find('img').filter((_, img) => {
        const src = $(img).attr('src') || $(img).attr('data-src') || '';
        return src && !src.includes('flagcdn.com') && !src.includes('logo-ileague');
      });

      if (imgs.length < 2) return;

      const fullText = cleanText(card.text());
      if (fullText.length < 6 || fullText.length > 400) return;

      const detailLink = card.is('a')
        ? card.attr('href')
        : card.find('a[href*="/match"], a[href*="/detail"], a[href]').first().attr('href');

      const matchId = card.attr('data-id') || extractMatchId(detailLink) || `match-${i + 1}`;

      // Ekstrak nama klub dari teks elemen anak atau atribut alt logo
      const names = [];
      card.find('span, p, div, h3, h4, h5, td, strong').each((_, node) => {
        if ($(node).children().length === 0) {
          const t = cleanText($(node).text());
          if (
            t &&
            t.length >= 3 &&
            t.length <= 45 &&
            !/^\d+([:-]\d+)?$/.test(t) &&
            !/^(vs|ft|ht|live|wib|wita|wit|stadion|stadium)$/i.test(t) &&
            !/\d{1,2}\s+(jan|feb|mar|apr|mei|jun|jul|agu|sep|okt|nov|des|january|february|march|april|may|june|july|august|september|october|november|december)/i.test(t)
          ) {
            if (!names.includes(t)) names.push(t);
          }
        }
      });

      const homeName = names[0] || cleanText($(imgs[0]).attr('alt'));
      const awayName = names[1] || cleanText($(imgs[1]).attr('alt'));

      if (!homeName || !awayName || homeName === awayName) return;

      const dedupKey = `${homeName}-${awayName}-${detailLink || i}`;
      if (seen.has(dedupKey)) return;
      seen.add(dedupKey);

      const homeLogo = normalizeUrl($(imgs[0]).attr('data-src') || $(imgs[0]).attr('src'));
      const awayLogo = normalizeUrl($(imgs[1]).attr('data-src') || $(imgs[1]).attr('src'));

      // Deteksi skor (misal "2 - 1" atau angka terpisah di antara kedua logo)
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
      path_used: targetPath,
      updated_at: new Date().toISOString(),
      total: filtered.length,
      data: filtered
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil jadwal pertandingan dari ileague.id',
      error: error.message
    });
  }
};
