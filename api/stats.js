const cheerio = require('cheerio');
const { httpClient } = require('../lib/httpClient');
const { normalizeUrl, cleanText, handleCors } = require('../lib/helpers');

function parseStatList($, containerSelector) {
  const list = [];
  $(containerSelector)
    .find('tr, .player-item, .stat-row')
    .each((i, el) => {
      const row = $(el);
      const playerName = cleanText(row.find('.player-name, .nama-pemain, td:nth-child(2)').first().text());
      if (!playerName || playerName.toLowerCase() === 'pemain') return;

      const clubName = cleanText(row.find('.club-name, .team-name, td:nth-child(3)').first().text());
      const imgs = row.find('img');
      const playerPhoto = normalizeUrl($(imgs[0]).attr('data-src') || $(imgs[0]).attr('src'));
      const clubLogo = imgs.length > 1
        ? normalizeUrl($(imgs[1]).attr('data-src') || $(imgs[1]).attr('src'))
        : playerPhoto;

      const valueText = cleanText(row.find('.stat-value, .goals, .assists, td:last-child').text()).replace(/\D/g, '');
      const total = parseInt(valueText, 10) || 0;

      list.push({
        rank: list.length + 1,
        player: playerName,
        photo: imgs.length > 1 ? playerPhoto : null,
        club: clubName,
        club_logo: clubLogo,
        total
      });
    });
  return list;
}

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    let html;
    try {
      const response = await httpClient.get('/statistik');
      html = response.data;
    } catch {
      const fallback = await httpClient.get('/');
      html = fallback.data;
    }

    const $ = cheerio.load(html);

    let topScorers = parseStatList($, '#top-scorer, .top-scorers, [data-tab="goals"]');
    let topAssists = parseStatList($, '#top-assist, .top-assists, [data-tab="assists"]');

    if (topScorers.length === 0 && topAssists.length === 0) {
      const tables = $('table');
      if (tables.length >= 1) topScorers = parseStatList($, tables[0]);
      if (tables.length >= 2) topAssists = parseStatList($, tables[1]);
    }

    res.status(200).json({
      success: true,
      source: 'ileague.id',
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
