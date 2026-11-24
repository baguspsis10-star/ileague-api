const cheerio = require('cheerio');
const { httpClient } = require('../lib/httpClient');
const { normalizeUrl, cleanText, handleCors } = require('../lib/helpers');

const COMPETITION = 'BRI_SUPER_LEAGUE_2026-27';

function extractPlayersFromContainer($, container) {
  const list = [];
  $(container)
    .find('tr, .player-item, .stat-item, .card, li')
    .each((_, el) => {
      const row = $(el);
      if (row.find('th').length > 0) return;

      const imgs = row.find('img').filter((__, img) => {
        const src = $(img).attr('data-src') || $(img).attr('src') || '';
        return src && !src.includes('flagcdn.com');
      });

      const texts = [];
      row.find('td, span, p, div, h4, h5, strong, a').each((__, node) => {
        if ($(node).children().length === 0) {
          const t = cleanText($(node).text());
          if (t && !/^\d+$/.test(t) && /[a-zA-Z]{2,}/.test(t) && !texts.includes(t)) {
            texts.push(t);
          }
        }
      });

      const player = texts[0] || '';
      const club = texts[1] || '';
      if (!player || /^(pemain|player|nama|klub|club)$/i.test(player)) return;

      // Cari angka statistik terbesar di baris tersebut (bukan nomor urut 1, 2, 3)
      const nums = [];
      row.find('td, span, p, div, strong').each((__, node) => {
        if ($(node).children().length === 0) {
          const t = cleanText($(node).text());
          if (/^\d{1,3}$/.test(t)) nums.push(parseInt(t, 10));
        }
      });

      const total = nums.length > 0 ? nums[nums.length - 1] : 0;
      if (total === 0 && nums.length === 0) return;

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
    const { debug } = req.query;
    const candidatePaths = [
      `/top_actions/player/${COMPETITION}`,
      `/top_actions/index/${COMPETITION}`,
      `/top_actions/club/${COMPETITION}`
    ];

    let html = '';
    let usedPath = candidatePaths[0];

    for (const path of candidatePaths) {
      try {
        const resp = await httpClient.get(path);
        if (resp.data && typeof resp.data === 'string' && resp.data.length > 1000) {
          html = resp.data;
          usedPath = path;
          if (html.includes('GOAL') || html.includes('GOL') || html.includes('ASSIST') || cheerio.load(html)('table').length > 0) {
            break;
          }
        }
      } catch (_) {}
    }

    const $ = cheerio.load(html);

    if (debug === '1') {
      const headings = [];
      $('h1, h2, h3, h4, .card-header, .nav-tabs a').each((_, el) => {
        const t = cleanText($(el).text());
        if (t && headings.length < 25) headings.push(t);
      });

      const playerLinks = [];
      $('a[href*="/player"], a[href*="/pemain"], a[href*="/top_actions"]').each((_, el) => {
        const href = $(el).attr('href');
        const text = cleanText($(el).text());
        if (href && playerLinks.length < 20) playerLinks.push({ href, text });
      });

      return res.status(200).json({
        success: true,
        usedPath,
        totalTables: $('table').length,
        headings,
        playerLinks,
        bodySnippet: cleanText($('main, .content, body').first().text()).slice(0, 1000)
      });
    }

    let topScorers = [];
    let topAssists = [];

    const tables = $('table');
    if (tables.length >= 1) topScorers = extractPlayersFromContainer($, tables[0]);
    if (tables.length >= 2) topAssists = extractPlayersFromContainer($, tables[1]);

    // Jika tidak memakai <table>, cari berdasarkan section/card berjudul Goal & Assist
    if (topScorers.length === 0 && topAssists.length === 0) {
      $('.card, .panel, section, .tab-pane, .box').each((_, box) => {
        const title = cleanText($(box).find('h2, h3, h4, .card-header, .box-title').first().text()).toUpperCase();
        if ((title.includes('GOAL') || title.includes('GOL') || title.includes('SCORER')) && topScorers.length === 0) {
          topScorers = extractPlayersFromContainer($, box);
        } else if (title.includes('ASSIST') && topAssists.length === 0) {
          topAssists = extractPlayersFromContainer($, box);
        }
      });
    }

    res.status(200).json({
      success: true,
      source: 'ileague.id',
      competition: COMPETITION,
      path_used: usedPath,
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
