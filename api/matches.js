const cheerio = require('cheerio');
const { httpClient } = require('../lib/httpClient');
const { normalizeUrl, cleanText, handleCors, extractMatchId } = require('../lib/helpers');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    const { status: filterStatus, week } = req.query;
    const targetPath = week ? `/jadwal-pertandingan?week=${encodeURIComponent(week)}` : '/jadwal-pertandingan';

    let html;
    try {
      const response = await httpClient.get(targetPath);
      html = response.data;
    } catch {
      const fallback = await httpClient.get('/');
      html = fallback.data;
    }

    const $ = cheerio.load(html);
    const matches = [];

    $('.match-item, .schedule-item, .card-match, tr[data-match], .fixture-row').each((i, el) => {
      const card = $(el);

      const detailLink = card.find('a[href*="match"], a[href*="pertandingan"]').attr('href') || card.find('a').attr('href');
      const matchId = card.attr('data-id') || extractMatchId(detailLink) || `match-${i + 1}`;

      const teams = card.find('.team-name, .club-name, .nama-klub');
      const logos = card.find('img');

      const homeName = cleanText($(teams[0]).text()) || cleanText(card.find('.home-team').text());
      const awayName = cleanText($(teams[1]).text()) || cleanText(card.find('.away-team').text());

      if (!homeName || !awayName) return;

      const homeLogo = normalizeUrl($(logos[0]).attr('data-src') || $(logos[0]).attr('src'));
      const awayLogo = normalizeUrl($(logos[1]).attr('data-src') || $(logos[1]).attr('src'));

      const scoreText = cleanText(card.find('.score, .match-score, .skor').text());
      const scores = scoreText.match(/(\d+)\s*[-:]\s*(\d+)/);

      const rawStatus = cleanText(card.find('.status, .match-status, .badge').text()).toUpperCase();
      let status = 'UPCOMING';
      if (rawStatus.includes('LIVE') || rawStatus.includes('BERLANGSUNG') || rawStatus.includes('HT') || rawStatus.includes("'")) {
        status = 'LIVE';
      } else if (rawStatus.includes('FT') || rawStatus.includes('SELESAI') || scores) {
        status = 'FINISHED';
      }

      const date = cleanText(card.find('.date, .match-date, .tanggal').text());
      const time = cleanText(card.find('.time, .match-time, .jam').text());
      const venue = cleanText(card.find('.venue, .stadium, .stadion').text());
      const matchweek = cleanText(card.find('.week, .pekan').text()) || (week ? `Pekan ${week}` : null);

      matches.push({
        id: matchId,
        status,
        minute: status === 'LIVE' ? rawStatus : null,
        matchweek,
        date,
        time,
        venue,
        home: {
          name: homeName,
          logo: homeLogo,
          score: scores ? parseInt(scores[1], 10) : null
        },
        away: {
          name: awayName,
          logo: awayLogo,
          score: scores ? parseInt(scores[2], 10) : null
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
