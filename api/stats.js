const cheerio = require('cheerio');
const { httpClient } = require('../lib/httpClient');
const { normalizeUrl, cleanText, handleCors } = require('../lib/helpers');

const COMPETITION = 'BRI_SUPER_LEAGUE_2026-27';

function parseStatSection($, section) {
  const players = [];
  const seen = new Set();

  if (!section || section.length === 0) return players;

  section.find('tr, .player-item, .stat-item, .card, li, .row').each((_, el) => {
    const row = $(el);
    // Hindari container pembungkus luar yang terlalu besar
    if (row.find('tr, .player-item, .stat-item').length > 1) return;

    const imgs = row.find('img').filter((__, img) => {
      const src = $(img).attr('data-src') || $(img).attr('src') || '';
      return src && !src.includes('flagcdn.com') && !src.includes('competition-logo');
    });

    const texts = [];
    row.find('td, span, p, div, h3, h4, h5, strong, a').each((__, node) => {
      if ($(node).children().length === 0) {
        const t = cleanText($(node).text());
        if (t && !/^\d+$/.test(t) && /[a-zA-Z]{2,}/.test(t) && !texts.includes(t)) {
          texts.push(t);
        }
      }
    });

    const player = texts[0] || '';
    const club = texts[1] || '';
    if (!player || player.length < 3 || seen.has(player.toLowerCase())) return;
    if (/^(pemain|player|nama|klub|club|goals|assists|gol|assist)$/i.test(player)) return;

    const nums = [];
    row.find('td, span, p, div, strong, b').each((__, node) => {
      if ($(node).children().length === 0) {
        const t = cleanText($(node).text());
        if (/^\d{1,2}$/.test(t)) nums.push(parseInt(t, 10));
      }
    });

    const total = nums.length > 0 ? nums[nums.length - 1] : 0;
    if (total === 0) return;

    seen.add(player.toLowerCase());

    let photo = null;
    let clubLogo = null;
    imgs.each((__, img) => {
      const src = normalizeUrl($(img).attr('data-src') || $(img).attr('src'));
      if (!src) return;
      if (src.includes('/uploads/images/logo/')) {
        clubLogo = src;
      } else if (!photo) {
        photo = src;
      }
    });

    players.push({
      rank: players.length + 1,
      player,
      photo,
      club,
      club_logo: clubLogo,
      total
    });
  });

  return players;
}

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    const { debug } = req.query;
    const response = await httpClient.get('/');
    const $ = cheerio.load(response.data || '');

    const goalsSection = $('#goals, [id*="goal" i], [data-tab="goals"]').first();
    const assistsSection = $('#assists, [id*="assist" i], [data-tab="assists"]').first();

    if (debug === '1') {
      return res.status(200).json({
        success: true,
        goalsFound: goalsSection.length > 0,
        assistsFound: assistsSection.length > 0,
        goalsHtmlSample: (goalsSection.html() || '').slice(0, 2500),
        assistsHtmlSample: (assistsSection.html() || '').slice(0, 2500)
      });
    }

    const topScorers = parseStatSection($, goalsSection);
    const topAssists = parseStatSection($, assistsSection);

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
