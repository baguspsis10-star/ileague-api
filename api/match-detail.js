const cheerio = require('cheerio');
const { httpClient } = require('../lib/httpClient');
const { normalizeUrl, cleanText, handleCors } = require('../lib/helpers');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  const { id, url } = req.query;
  if (!id && !url) {
    return res.status(400).json({
      success: false,
      message: 'Parameter query "id" atau "url" wajib diisi. Contoh: /api/match-detail?id=persib-vs-persija'
    });
  }

  try {
    const targetPath = url ? url : `/pertandingan/${encodeURIComponent(id)}`;
    const response = await httpClient.get(targetPath);
    const $ = cheerio.load(response.data);

    const teamNames = $('.match-header .team-name, .scoreboard .club-name');
    const teamLogos = $('.match-header img, .scoreboard img');
    const scoreText = cleanText($('.match-header .score, .scoreboard .score').text());
    const scores = scoreText.match(/(\d+)\s*[-:]\s*(\d+)/);

    const events = [];
    $('.event-item, .timeline-item, .match-event').each((_, el) => {
      const ev = $(el);
      const minute = cleanText(ev.find('.minute, .time, .menit').text());
      const player = cleanText(ev.find('.player, .player-name').text());
      const rawType = (ev.attr('class') + ' ' + ev.find('i, img').attr('alt')).toLowerCase();

      let type = 'EVENT';
      if (rawType.includes('goal') || rawType.includes('gol')) type = 'GOAL';
      else if (rawType.includes('yellow') || rawType.includes('kuning')) type = 'YELLOW_CARD';
      else if (rawType.includes('red') || rawType.includes('merah')) type = 'RED_CARD';
      else if (rawType.includes('sub') || rawType.includes('ganti')) type = 'SUBSTITUTION';

      const side = ev.hasClass('away') || ev.find('.away').length ? 'away' : 'home';

      if (player || minute) {
        events.push({ minute, side, type, player });
      }
    });

    const parseLineup = (selector) => {
      const players = [];
      $(selector)
        .find('li, .player-row, tr')
        .each((_, el) => {
          const number = cleanText($(el).find('.number, .no').text());
          const name = cleanText($(el).find('.name, .player-name').text()) || cleanText($(el).text());
          if (name) players.push({ number: number || null, name });
        });
      return players;
    };

    const statistics = [];
    $('.stat-item, .stats-row, .match-stats tr').each((_, el) => {
      const row = $(el);
      const label = cleanText(row.find('.stat-label, .label, td:nth-child(2)').text());
      const homeVal = cleanText(row.find('.home-stat, td:first-child').text());
      const awayVal = cleanText(row.find('.away-stat, td:last-child').text());
      if (label && (homeVal || awayVal)) {
        statistics.push({ label, home: homeVal, away: awayVal });
      }
    });

    res.status(200).json({
      success: true,
      source: 'ileague.id',
      updated_at: new Date().toISOString(),
      data: {
        id: id || null,
        status: cleanText($('.match-status, .status').first().text()) || 'FINISHED',
        venue: cleanText($('.venue, .stadium').first().text()) || null,
        date: cleanText($('.match-date, .date').first().text()) || null,
        home: {
          name: cleanText($(teamNames[0]).text()) || 'Home',
          logo: normalizeUrl($(teamLogos[0]).attr('data-src') || $(teamLogos[0]).attr('src')),
          score: scores ? parseInt(scores[1], 10) : null,
          lineup: parseLineup('.home-lineup, .lineup-home')
        },
        away: {
          name: cleanText($(teamNames[1]).text()) || 'Away',
          logo: normalizeUrl($(teamLogos[1]).attr('data-src') || $(teamLogos[1]).attr('src')),
          score: scores ? parseInt(scores[2], 10) : null,
          lineup: parseLineup('.away-lineup, .lineup-away')
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
