const cheerio = require('cheerio');
const { httpClient } = require('../lib/httpClient');
const { normalizeUrl, cleanText, handleCors } = require('../lib/helpers');

const COMPETITION = 'BRI_SUPER_LEAGUE_2026-27';

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  const { id, url } = req.query;
  if (!id && !url) {
    return res.status(400).json({
      success: false,
      message: 'Parameter "id" atau "url" wajib diisi. Contoh: /api/match-detail?id=2026-11-26/BORNEO_FC_SAMARINDA/PERSITA'
    });
  }

  try {
    const targetPath = url
      ? url
      : `/result/detail/${COMPETITION}/${id}`;

    const response = await httpClient.get(targetPath);
    const $ = cheerio.load(response.data || '');

    const imgs = $('img').filter((_, img) => {
      const src = $(img).attr('data-src') || $(img).attr('src') || '';
      return src && !src.includes('flagcdn.com') && !src.includes('logo-ileague');
    });

    const urlParts = targetPath.replace(/\/$/, '').split('/');
    const awaySlug = urlParts[urlParts.length - 1] || 'Away';
    const homeSlug = urlParts[urlParts.length - 2] || 'Home';
    const dateFromUrl = urlParts[urlParts.length - 3] || null;

    const scoreText = cleanText($('.score, .match-score, h1, h2').text());
    const scores = scoreText.match(/\b(\d{1,2})\s*[-:]\s*(\d{1,2})\b/);

    const events = [];
    $('tr, li, .event-item, .timeline-item').each((_, el) => {
      const row = $(el);
      const text = cleanText(row.text());
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

    const statistics = [];
    $('table tr').each((_, el) => {
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
          name: homeSlug.replace(/_+/g, ' '),
          logo: normalizeUrl($(imgs[0]).attr('data-src') || $(imgs[0]).attr('src')),
          score: scores ? parseInt(scores[1], 10) : null
        },
        away: {
          name: awaySlug.replace(/_+/g, ' '),
          logo: normalizeUrl($(imgs[1]).attr('data-src') || $(imgs[1]).attr('src')),
          score: scores ? parseInt(scores[2], 10) : null
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
