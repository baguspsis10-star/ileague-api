const cheerio = require('cheerio');
const { httpClient } = require('../lib/httpClient');
const { normalizeUrl, cleanText, handleCors } = require('../lib/helpers');

const COMPETITION = 'BRI_SUPER_LEAGUE_2026-27';

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  const { id, url, debug } = req.query;
  if (!id && !url) {
    return res.status(400).json({
      success: false,
      message: 'Parameter "id" atau "url" wajib diisi. Contoh: /api/match-detail?id=2026-11-20/GARUDAYAKSA_FC/MADURA_UNITED_FC'
    });
  }

  try {
    const targetPath = url ? url : `/result/detail/${COMPETITION}/${id}`;
    const response = await httpClient.get(targetPath, {
      headers: { Referer: 'https://ileague.id/fixtures' }
    });

    const finalUrl = response.request?.res?.responseUrl || targetPath;
    const html = response.data || '';
    const $ = cheerio.load(html);

    if (debug === '1') {
      const headings = [];
      $('h1, h2, h3, h4, .nav-tabs a, .card-header, .title').each((_, el) => {
        const t = cleanText($(el).text());
        if (t && headings.length < 30) headings.push(t);
      });

      const matchImages = [];
      $('main img, .content img, section img, .container img').each((_, el) => {
        const src = $(el).attr('data-src') || $(el).attr('src') || '';
        if (src && !src.includes('flagcdn.com') && matchImages.length < 20) {
          matchImages.push({
            src,
            parentClass: $(el).parent().attr('class') || ''
          });
        }
      });

      return res.status(200).json({
        success: true,
        targetPath,
        finalUrl,
        title: cleanText($('title').text()),
        headings,
        matchImages,
        bodySnippet: cleanText($('main, .content, .container, body').first().text()).slice(0, 1500)
      });
    }

    const urlParts = targetPath.replace(/\/$/, '').split('/');
    const awaySlug = urlParts[urlParts.length - 1] || 'Away';
    const homeSlug = urlParts[urlParts.length - 2] || 'Home';
    const dateFromUrl = urlParts[urlParts.length - 3] || null;

    // Ambil logo klub hanya dari area konten utama (abaikan header, nav, footer, competition-logo)
    const clubLogos = [];
    $('main img, .content img, .container img').each((_, img) => {
      if ($(img).closest('header, nav, footer').length > 0) return;
      const src = normalizeUrl($(img).attr('data-src') || $(img).attr('src'));
      if (
        src &&
        src.includes('/uploads/images/logo/') &&
        !src.includes('competition-logo') &&
        !clubLogos.includes(src)
      ) {
        clubLogos.push(src);
      }
    });

    // Cari skor pertandingan di area header/scoreboard utama
    const mainText = cleanText($('main, .content, .container').first().text());
    const scoreMatch = mainText.match(/\b(\d{1,2})\s*[-:]\s*(\d{1,2})\b/);

    // Ekstrak kejadian pertandingan (Gol, Kartu Kuning, Kartu Merah, Pergantian)
    const events = [];
    $('tr, li, .event-item, .timeline-item, .row').each((_, el) => {
      const row = $(el);
      if (row.closest('header, nav, footer').length > 0) return;
      if (row.find('tr, li').length > 1) return;

      const text = cleanText(row.text());
      if (text.length > 150) return;

      const minMatch = text.match(/\b(\d{1,3}(?:\+\d+)?')\b/);
      if (!minMatch) return;

      const htmlLower = (row.html() || '').toLowerCase();
      let type = 'EVENT';
      if (htmlLower.includes('goal') || htmlLower.includes('ball') || htmlLower.includes('gol')) type = 'GOAL';
      else if (htmlLower.includes('yellow') || htmlLower.includes('kuning')) type = 'YELLOW_CARD';
      else if (htmlLower.includes('red') || htmlLower.includes('merah')) type = 'RED_CARD';
      else if (htmlLower.includes('sub') || htmlLower.includes('exchange') || htmlLower.includes('ganti')) type = 'SUBSTITUTION';

      events.push({
        minute: minMatch[1],
        type,
        detail: text
      });
    });

    // Ekstrak statistik pertandingan (Penguasaan bola, tembakan, pelanggaran, dll.)
    const statistics = [];
    $('table tr, .stat-row, .stats-item').each((_, el) => {
      const cols = $(el).find('td');
      if (cols.length === 3) {
        const homeVal = cleanText($(cols[0]).text());
        const label = cleanText($(cols[1]).text());
        const awayVal = cleanText($(cols[2]).text());
        if (label && /\d/.test(homeVal) && /\d/.test(awayVal)) {
          statistics.push({ label, home: homeVal, away: awayVal });
        }
      }
    });

    res.status(200).json({
      success: true,
      source: 'ileague.id',
      updated_at: new Date().toISOString(),
      data: {
        id: id || null,
        date: dateFromUrl,
        home: {
          name: homeSlug.replace(/_+/g, ' ').trim(),
          logo: clubLogos[0] || null,
          score: scoreMatch ? parseInt(scoreMatch[1], 10) : null
        },
        away: {
          name: awaySlug.replace(/_+/g, ' ').trim(),
          logo: clubLogos[1] || null,
          score: scoreMatch ? parseInt(scoreMatch[2], 10) : null
        },
        events,
        statistics
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil detail pertandingan dari ileague.id',
      error: error.message
    });
  }
};
