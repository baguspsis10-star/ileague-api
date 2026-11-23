const cheerio = require('cheerio');
const { httpClient } = require('../lib/httpClient');
const { normalizeUrl, cleanText, handleCors } = require('../lib/helpers');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    let html;
    try {
      const response = await httpClient.get('/klasemen');
      html = response.data;
    } catch {
      const fallback = await httpClient.get('/');
      html = fallback.data;
    }

    const $ = cheerio.load(html);
    const standings = [];

    $('table tbody tr').each((index, row) => {
      const cols = $(row).find('td');
      if (cols.length < 8) return;

      const rankText = cleanText($(cols[0]).text()).replace(/\D/g, '');
      const rank = rankText ? parseInt(rankText, 10) : index + 1;

      const clubCell = $(cols[1]);
      const clubName = cleanText(clubCell.find('.club-name, .team-name, span, a').first().text()) || cleanText(clubCell.text());
      const logoImg = clubCell.find('img');
      const clubLogo = normalizeUrl(logoImg.attr('data-src') || logoImg.attr('src'));

      if (!clubName) return;

      const played = parseInt(cleanText($(cols[2]).text()), 10) || 0;
      const win = parseInt(cleanText($(cols[3]).text()), 10) || 0;
      const draw = parseInt(cleanText($(cols[4]).text()), 10) || 0;
      const loss = parseInt(cleanText($(cols[5]).text()), 10) || 0;
      const goalsFor = parseInt(cleanText($(cols[6]).text()), 10) || 0;
      const goalsAgainst = parseInt(cleanText($(cols[7]).text()), 10) || 0;

      const goalDiff = cols.length >= 10
        ? parseInt(cleanText($(cols[8]).text()), 10) || (goalsFor - goalsAgainst)
        : goalsFor - goalsAgainst;

      const points = cols.length >= 10
        ? parseInt(cleanText($(cols[9]).text()), 10) || 0
        : parseInt(cleanText($(cols[8]).text()), 10) || 0;

      const form = [];
      $(row)
        .find('.form-badge, .last-match span, td:last-child span')
        .each((_, badge) => {
          const val = cleanText($(badge).text()).toUpperCase();
          if (['W', 'D', 'L', 'M', 'S', 'K'].includes(val)) {
            const map = { M: 'W', S: 'D', K: 'L' };
            form.push(map[val] || val);
          }
        });

      standings.push({
        rank,
        club: clubName,
        logo: clubLogo,
        played,
        win,
        draw,
        loss,
        goals_for: goalsFor,
        goals_against: goalsAgainst,
        goal_difference: goalDiff,
        points,
        form: form.slice(-5)
      });
    });

    res.status(200).json({
      success: true,
      source: 'ileague.id',
      updated_at: new Date().toISOString(),
      total: standings.length,
      data: standings
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil klasemen dari ileague.id',
      error: error.message
    });
  }
};
