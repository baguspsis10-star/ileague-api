const cheerio = require('cheerio');
const { httpClient } = require('../lib/httpClient');
const { normalizeUrl, cleanText, handleCors } = require('../lib/helpers');

const COMPETITION = 'BRI_SUPER_LEAGUE_2026-27';

function parseStatTable($, tableEl) {
  const list = [];
  $(tableEl)
    .find('tbody tr')
    .each((i, el) => {
      const cols = $(el).find('td');
      if (cols.length < 3) return;

      const imgs = $(el)
        .find('img')
        .filter((_, img) => {
          const src = $(img).attr('data-src') || $(img).attr('src') || '';
          return src && !src.includes('flagcdn.com');
        });

      const texts = [];
      cols.each((_, col) => {
        const t = cleanText($(col).text());
        if (t && !/^\d+$/.test(t) && /[a-zA-Z]{2,}/.test(t)) {
          texts.push(t);
        }
      });

      const player = texts[0] || '';
      const club = texts[1] || '';
      if (!player) return;

      const lastColNum = cleanText(cols.last().text()).replace(/\D/g, '');
      const total = parseInt(lastColNum, 10) || 0;

      const photo = imgs.length > 1
        ? normalizeUrl($(imgs[0]).attr('data-src') || $(imgs[0]).attr('src'))
        : null;
      const clubLogo = imgs.length > 1
        ? normalizeUrl($(imgs[1]).attr('data-src') || $(imgs[1]).attr('src'))
        : normalizeUrl($(imgs[0]).attr('data-src') || $(imgs[0]).attr('src'));

      list.push({
        rank: list.length + 1,
        player,
        photo,
        club,
        club_logo: clubLogo,
        total
      });
    });

  return list;
}

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    const response = await httpClient.get(`/top_actions/player/${COMPETITION}`);
    const $ = cheerio.load(response.data || '');
    const tables = $('table');

    const topScorers = tables.length >= 1 ? parseStatTable($, tables[0]) : [];
    const topAssists = tables.length >= 2 ? parseStatTable($, tables[1]) : [];

    res.status(200).json({
      success: true,
      source: 'ileague.id',
      competition: COMPETITION,
      updated_at: new Date().toISOString(),
      data: {
        top_scorers: topScorers,
        top_assists: topAssists
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil statistik pemain dari ileague.id',
      error: error.message
    });
  }
};
